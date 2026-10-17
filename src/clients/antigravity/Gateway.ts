import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { once, type EventEmitter } from "node:events";

import type { Connection } from "../../config/Connection.ts";
import { ProtocolError, streamChat, type ChatMessage, type ImpactChatRequest } from "../cursor/Impact.ts";

const Part = Schema.Struct({
  text: Schema.optional(Schema.String),
  thought: Schema.optional(Schema.Boolean),
  inlineData: Schema.optional(Schema.Struct({ mimeType: Schema.String, data: Schema.String })),
  fileData: Schema.optional(Schema.Struct({ mimeType: Schema.String, fileUri: Schema.String })),
  functionCall: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.String, args: Schema.Unknown })),
  functionResponse: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.String, response: Schema.Unknown })),
});
const Content = Schema.Struct({ role: Schema.optional(Schema.String), parts: Schema.Array(Part) });
const Request = Schema.Struct({
  contents: Schema.Array(Content),
  systemInstruction: Schema.optional(Content),
  tools: Schema.optional(Schema.Array(Schema.Struct({ functionDeclarations: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String, description: Schema.optional(Schema.String), parameters: Schema.optional(Schema.Unknown), parametersJsonSchema: Schema.optional(Schema.Unknown),
  }))) }))),
  generationConfig: Schema.optional(Schema.Struct({ maxOutputTokens: Schema.optional(Schema.Int), temperature: Schema.optional(Schema.Number), topP: Schema.optional(Schema.Number), stopSequences: Schema.optional(Schema.Array(Schema.String)) })),
  toolConfig: Schema.optional(Schema.Struct({ functionCallingConfig: Schema.optional(Schema.Struct({ mode: Schema.optional(Schema.String), allowedFunctionNames: Schema.optional(Schema.Array(Schema.String)) })) })),
});
const readRequest = Schema.decodeUnknownSync(Request);

/** Gemini schemas use uppercase type names; property names and descriptions must stay intact. */
export function toolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toolSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, key === "type" && typeof child === "string" ? child.toLowerCase() : toolSchema(child)]));
  return value;
}

export function chatRequest(body: unknown, model: string, maxOutputTokens?: number): ImpactChatRequest {
  let input: typeof Request.Type;
  try { input = readRequest(body); } catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity generation request."); }
  const messages: ChatMessage[] = [];
  if (input.systemInstruction) messages.push({ role: "system", content: input.systemInstruction.parts.flatMap(p => p.text ? [p.text] : []).join("\n\n") });
  const pending: { id: string; name: string }[] = [];
  for (const content of input.contents) {
    const parts: unknown[] = [], calls: unknown[] = [], results: ChatMessage[] = [];
    for (const part of content.parts) {
      if (part.thought) continue;
      if (part.text) parts.push({ type: "text", text: part.text });
      if (part.inlineData) {
        if (!part.inlineData.mimeType.startsWith("image/")) throw new ProtocolError("invalid_argument", "This Impact route supports image attachments only.");
        parts.push({ type: "image_url", image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } });
      }
      if (part.fileData) throw new ProtocolError("invalid_argument", "Remote Gemini file attachments are unavailable through Impact. Attach the file content instead.");
      if (part.functionCall) {
        const call = part.functionCall, id = call.id || `call_${randomUUID().replaceAll("-", "")}`;
        calls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } });
        pending.push({ id, name: call.name });
      }
      if (part.functionResponse) {
        const result = part.functionResponse;
        const index = pending.findIndex(call => result.id ? call.id === result.id : call.name === result.name);
        if (index < 0) throw new ProtocolError("invalid_argument", "Antigravity sent a tool result without its call.");
        const [call] = pending.splice(index, 1);
        results.push({ role: "tool", tool_call_id: call!.id, content: JSON.stringify(result.response) });
      }
    }
    if (parts.length || calls.length) messages.push({ role: content.role === "model" ? "assistant" : "user", content: parts.length ? parts : null, ...(calls.length ? { tool_calls: calls } : {}) });
    messages.push(...results);
  }
  if (input.tools?.some(tool => !tool.functionDeclarations?.length)) throw new ProtocolError("unimplemented", "Gemini hosted tools are unavailable through Impact. Use Antigravity's local tools instead.");
  let tools = input.tools?.flatMap(tool => tool.functionDeclarations ?? []).map(fn => ({ type: "function", function: { name: fn.name, ...(fn.description ? { description: fn.description } : {}), parameters: toolSchema(fn.parametersJsonSchema ?? fn.parameters ?? { type: "object", properties: {} }) } }));
  const config = input.generationConfig, requested = config?.maxOutputTokens;
  const mode = input.toolConfig?.functionCallingConfig;
  if (mode?.mode === "ANY" && mode.allowedFunctionNames?.length) tools = tools?.filter(tool => mode.allowedFunctionNames!.includes(tool.function.name));
  const request: ImpactChatRequest = {
    model, messages,
    ...(tools?.length ? { tools } : {}),
    ...(requested && requested > 0 ? { max_tokens: Math.min(requested, maxOutputTokens ?? requested) } : {}),
    ...(config?.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config?.topP !== undefined ? { top_p: config.topP } : {}),
    ...(config?.stopSequences?.length ? { stop: config.stopSequences } : {}),
  };
  if (mode?.mode === "NONE") request.tool_choice = "none";
  if (mode?.mode === "ANY") request.tool_choice = mode.allowedFunctionNames?.length === 1 ? { type: "function", function: { name: mode.allowedFunctionNames[0] } } : "required";
  return request;
}

/** The shared response surface of Node HTTP/1 and HTTP/2, without incompatible overloads. */
export interface GatewayResponse extends EventEmitter {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(): unknown;
  end(chunk: string): unknown;
}

export const writeEvent = async (response: GatewayResponse, body: unknown, signal: AbortSignal) => {
  signal.throwIfAborted();
  if (!response.write(`data: ${JSON.stringify(body)}\n\n`)) await once(response, "drain", { signal });
};

/** Text is forwarded as it arrives. Function arguments must be complete JSON before Gemini can consume them. */
export async function streamGeneration(connection: Connection, request: ImpactChatRequest, response: GatewayResponse, signal: AbortSignal, envelope: (body: unknown) => unknown = body => body) {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish = "STOP", usage: unknown;
  const event = (parts: unknown[], done = false) => envelope({ candidates: [{ index: 0, content: { role: "model", parts }, ...(done ? { finishReason: finish } : {}) }], ...(done && usage ? { usageMetadata: usage } : {}) });
  for await (const delta of streamChat(connection, request, signal)) {
    if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    if (delta.reasoning) await writeEvent(response, event([{ text: delta.reasoning, thought: true }]), signal);
    if (delta.content) await writeEvent(response, event([{ text: delta.content }]), signal);
    for (const fragment of delta.toolCalls ?? []) {
      const call = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
      if (fragment.id) call.id = fragment.id;
      if (fragment.name) call.name += fragment.name;
      call.arguments += fragment.arguments ?? "";
      calls.set(fragment.index, call);
    }
    if (delta.finishReason) finish = delta.finishReason === "length" ? "MAX_TOKENS" : delta.finishReason === "content_filter" ? "SAFETY" : "STOP";
    if (delta.usage) usage = { promptTokenCount: delta.usage.prompt_tokens ?? 0, candidatesTokenCount: delta.usage.completion_tokens ?? 0, totalTokenCount: (delta.usage.prompt_tokens ?? 0) + (delta.usage.completion_tokens ?? 0) };
  }
  const parts = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    let args: unknown;
    try { args = JSON.parse(call.arguments || "{}"); } catch { throw new ProtocolError("data_loss", "Impact returned invalid tool arguments."); }
    if (!call.name) throw new ProtocolError("data_loss", "Impact returned an unnamed tool call.");
    return { functionCall: { id: call.id || `call_${randomUUID()}`, name: call.name, args } };
  });
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  await writeEvent(response, event(parts, true), signal);
  response.end();
}

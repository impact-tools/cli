import type { IncomingMessage } from "node:http";

import { Redacted, Schema } from "effect";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { Connection } from "../../config/Connection.ts";

import { CLI_VERSION, VERSION_HEADER } from "../../api/Http.ts";

export class ProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}
export interface ImpactChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  [key: string]: unknown;
}
export interface ChatDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const Chunk = Schema.Struct({
  choices: Schema.Array(Schema.Struct({
    delta: Schema.Struct({
      content: optionalText,
      reasoning_content: optionalText,
      reasoning: optionalText,
      tool_calls: Schema.optional(Schema.Array(Schema.Struct({
        index: Schema.Int,
        id: Schema.optional(Schema.String),
        function: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), arguments: Schema.optional(Schema.String) })),
      }))),
    }),
    finish_reason: optionalText,
  })),
  usage: Schema.optional(Schema.NullOr(Schema.Struct({
    prompt_tokens: Schema.optional(Schema.Int), completion_tokens: Schema.optional(Schema.Int),
  }))),
});
const readChunk = Schema.decodeUnknownSync(Chunk);

export const codeForStatus = (status: number) =>
  status === 401 ? "unauthenticated" : status === 403 ? "permission_denied" : status === 429 ? "resource_exhausted" :
  status === 400 || status === 404 || status === 422 ? "invalid_argument" : "unavailable";

/** Uses a direct connection to Impact; native and proxy credentials never reach this request. */
export function impactRequest(connection: Connection, path: string, body: Buffer | undefined, signal: AbortSignal, headers: Record<string, string> = {}): Promise<IncomingMessage> {
  const url = new URL(path, connection.baseUrl);
  if (url.origin !== new URL(connection.baseUrl).origin) throw new ProtocolError("invalid_argument", "Invalid Impact route.");
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = transport(url, {
      method: body ? "POST" : "GET", signal,
      headers: {
        ...headers,
        authorization: `Bearer ${Redacted.value(connection.apiKey)}`,
        [VERSION_HEADER]: CLI_VERSION,
        "accept-encoding": "identity",
        ...(body ? { "content-length": String(body.length) } : {}),
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new ProtocolError(codeForStatus(status), `Impact answered HTTP ${status}.`));
      } else resolve(response);
    });
    outgoing.setTimeout(120_000, () => outgoing.destroy(new ProtocolError("deadline_exceeded", "Impact stopped responding.")));
    outgoing.on("error", (error) => reject(error instanceof ProtocolError ? error : new ProtocolError(signal.aborted ? "canceled" : "unavailable", signal.aborted ? "Request canceled." : "Cannot reach Impact.")));
    outgoing.end(body);
  });
}

/** Cursor-backed Grok excludes the active user message from its replay limit. */
export function packCursorReplay(request: ImpactChatRequest): ImpactChatRequest {
  if (!/^grok(?:-|$)/i.test(request.model)) return request;
  const active = request.messages.at(-1);
  const history = active?.role === "user" ? request.messages.slice(0, -1) : request.messages;
  // Leave room for the canonical adapter's JSON wrappers and tool labels.
  if (history.length <= 180 && Buffer.byteLength(JSON.stringify(history)) <= 480 * 1024)
    return request;
  const instructions = history.filter(message => message.role === "system");
  if (Buffer.byteLength(JSON.stringify(instructions)) > 480 * 1024)
    throw new ProtocolError("resource_exhausted", "Grok system instructions exceed Cursor's 512 KiB replay limit.");
  const transcript = history.filter(message => message.role !== "system");
  const content = [
    "Conversation history and workspace context follow as JSON. Preserve the chronological order, use completed tool results as history, and answer the current user message at the end.",
    JSON.stringify(transcript),
    "Current user message:",
    active?.role === "user" ? (typeof active.content === "string" ? active.content : JSON.stringify(active.content))
      : "Continue using the completed tool results above.",
  ].join("\n\n");
  return { ...request, messages: [...instructions, { role: "user", content }] };
}

export async function* streamChat(connection: Connection, request: ImpactChatRequest, signal: AbortSignal): AsyncGenerator<ChatDelta> {
  request = packCursorReplay(request);
  if (request.messages.length > 256) throw new ProtocolError("resource_exhausted", "Conversation exceeds 256 messages.");
  const body = Buffer.from(JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }));
  if (body.length > 4 * 1024 * 1024) throw new ProtocolError("resource_exhausted", "Conversation exceeds 4 MiB.");
  const response = await impactRequest(connection, "/v1/chat/completions", body, signal, { "content-type": "application/json", accept: "text/event-stream" });
  const decoder = new TextDecoder();
  let pending = "";
  let total = 0;
  let finished = false;
  try {
    for await (const bytes of response) {
      total += bytes.length;
      if (total > 16 * 1024 * 1024) throw new ProtocolError("resource_exhausted", "Impact response exceeds 16 MiB.");
      pending += decoder.decode(bytes, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, separator.index); pending = pending.slice(separator.index + separator[0].length);
        if (event.length > 1024 * 1024) throw new ProtocolError("resource_exhausted", "Impact event exceeds 1 MiB.");
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { finished = true; return; }
        let chunk: typeof Chunk.Type;
        try { chunk = readChunk(JSON.parse(data)); }
        catch { throw new ProtocolError("data_loss", "Impact returned an invalid generation event."); }
        const choice = chunk.choices[0];
        yield {
          ...(choice?.delta.content ? { content: choice.delta.content } : {}),
          ...(choice?.delta.reasoning_content || choice?.delta.reasoning ? { reasoning: choice?.delta.reasoning_content ?? choice?.delta.reasoning ?? undefined } : {}),
          ...(choice?.delta.tool_calls ? { toolCalls: choice.delta.tool_calls.map((call) => ({ index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments })) } : {}),
          ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
          ...(chunk.usage ? { usage: chunk.usage } : {}),
        };
      }
      if (pending.length > 1024 * 1024) throw new ProtocolError("resource_exhausted", "Impact event exceeds 1 MiB.");
    }
    if (!finished) throw new ProtocolError("data_loss", "Impact ended without a terminal generation event.");
  } catch (error) {
    if (signal.aborted) throw new ProtocolError("canceled", "Request canceled.");
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("unavailable", "Cannot read Impact's generation stream.");
  } finally { response.destroy(); }
}

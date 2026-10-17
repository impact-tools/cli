import { expect, it } from "vitest";
import { Redacted } from "effect";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { chatRequest, streamGeneration, toolSchema } from "../src/clients/antigravity/Gateway.ts";
import { accessToken, adaptMessage, requestJson, rpcBody, rpcReply, rpcError, upstreamJson } from "../src/clients/antigravity/Bridge.ts";
import { ideCatalog, ideTabRequest } from "../src/clients/antigravity/Ide.ts";
import { nativeCatalog, type GatewayModel } from "../src/clients/antigravity/Models.ts";

const model: GatewayModel = { id: "impact-test", key: 123456, label: "Impact Test", context_length: 131072, max_output_tokens: 8192 };
it("adapts system, images and parallel tool history without duplicating instructions or opaque thoughts", () => {
  const body = chatRequest({ systemInstruction: { parts: [{ text: "system once" }] }, contents: [
    { role: "user", parts: [{ text: "read" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] },
    { role: "model", parts: [{ text: "private thought", thought: true, thoughtSignature: "opaque" }, { functionCall: { name: "read", args: { path: "a" } } }, { functionCall: { name: "read", args: { path: "b" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { result: "a" } } }, { functionResponse: { name: "read", response: { result: "b" } } }] },
  ], generationConfig: { maxOutputTokens: 65536 } }, model.id, 8192);
  expect(body.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
  expect(body.messages[0]?.content).toBe("system once");
  expect(JSON.stringify(body)).not.toContain("private thought");
  const calls = body.messages[2]!.tool_calls as { id: string }[];
  expect(body.messages[3]!.tool_call_id).toBe(calls[0]!.id);
  expect(body.messages[4]!.tool_call_id).toBe(calls[1]!.id);
  expect(body.max_tokens).toBe(8192);
  expect(body.messages[1]?.content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
});
it("converts nested tool schemas while preserving property names and descriptions", () => {
  expect(toolSchema({ type: "OBJECT", properties: { URL: { type: "STRING", description: "UPPERCASE" }, nested: { type: "ARRAY", items: { type: "INTEGER" } } } })).toEqual({ type: "object", properties: { URL: { type: "string", description: "UPPERCASE" }, nested: { type: "array", items: { type: "integer" } } } });
});
it("rejects unmatched tool results and remote Gemini file IDs", () => {
  expect(() => chatRequest({ contents: [{ parts: [{ functionResponse: { name: "missing", response: {} } }] }] }, model.id)).toThrow("without its call");
  expect(() => chatRequest({ contents: [{ parts: [{ fileData: { fileUri: "gs://private/file", mimeType: "image/png" } }] }] }, model.id)).toThrow("Remote Gemini file");
  expect(() => chatRequest({ contents: [], tools: [{ googleSearch: {} }] }, model.id)).toThrow("hosted tools");
});
it("binds local credentials to the Impact login", () => {
  const a = { baseUrl: "https://impact.test", apiKey: Redacted.make("a") };
  expect(accessToken("local", a)).toBe(accessToken("local", a));
  expect(accessToken("local", a)).not.toBe(accessToken("local", { ...a, apiKey: Redacted.make("b") }));
});
it("keeps readable model selection and supplies native BYOM execution metadata", () => {
  const other = { ...model, key: 987654, id: "other", label: "Other Model" };
  const request = adaptMessage({ items: [{ text: "hello" }], cascadeConfig: { plannerConfig: { planModel: other.key, toolConfig: { preserved: true } } } }, [model, other], model) as any;
  expect(request.cascadeConfig.plannerConfig).toMatchObject({ planModel: 326, customModelInfoOverride: { modelName: "other", displayName: "Other Model" }, toolConfig: { preserved: true } });
  expect(nativeCatalog([model, other], other).defaultOverrideModelConfig.modelOrAlias.model).toBe(other.key);
  expect(nativeCatalog([model], model).clientModelConfigs[0]?.label).toBe("Impact Test");
});
it("exposes distinct IDE model keys, nested vision capabilities and native Tab metadata", () => {
  const other = { ...model, key: 987654, id: "other", label: "Other Model", capabilities: { image_input: { supported: true } } };
  const catalog = ideCatalog([model, other], other) as any;
  expect(catalog.defaultAgentModelId).toBe("other");
  expect(catalog.models.other).toMatchObject({ displayName: "Other Model", model: other.key, maxTokens: 131072, maxOutputTokens: 8192, supportsImages: true });
  expect(catalog.models[model.id].model).not.toBe(catalog.models.other.model);
  expect(catalog.models["impact-background-1036"].model).toBe(1036);
  expect(catalog.tabModelIds).toEqual(["impact-tab"]);
  expect(catalog.models["impact-tab"]).toMatchObject({ model: 312, supportsCumulativeContext: true });
  expect(nativeCatalog([other], other).clientModelConfigs[0]?.supportsImages).toBe(true);
});
it("rejects malformed, compressed and truncated RPC frames", () => {
  for (const data of [Buffer.from([0]), Buffer.from([0, 0, 0, 0, 9, 123]), Buffer.from([1, 0, 0, 0, 2, 123, 125])]) expect(() => rpcBody(data, "application/grpc-web+json")).toThrow("RPC frame");
  expect(rpcBody(Buffer.from([0, 0, 0, 0, 2, 123, 125]), "application/grpc-web+json")).toEqual({});
});
it("classifies malformed request and language-server JSON separately", () => {
  expect(() => requestJson(Buffer.from("{"))).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  expect(() => upstreamJson(Buffer.from("{"))).toThrow(expect.objectContaining({ code: "data_loss" }));
});
it("adapts IDE Tab into replacement text instead of an agent tool call, with the lowest supported reasoning effort", () => {
  const input = { systemInstruction: { parts: [{ text: "native system" }] }, contents: [{ role: "user", parts: [{ text: "return a + <|cursor|>" }] }], tools: [{ functionDeclarations: [{ name: "replace_file_content" }] }], generationConfig: { maxOutputTokens: 2048 } };
  const request = ideTabRequest(input, { ...model, reasoning_efforts: ["low", "medium"] });
  expect(request.tools).toHaveLength(1); expect(request.tool_choice).toBeUndefined();
  expect(ideTabRequest({ ...input, toolConfig: { functionCallingConfig: { mode: "NONE" } } }, model).tool_choice).toBe("none");
  expect(request.reasoning_effort).toBe("low"); expect(request.max_tokens).toBe(2048);
  expect(request.messages.filter(m => m.role === "system")).toHaveLength(1);
  expect(request.messages[0]?.content).toContain("native system");
  expect(request.messages[0]?.content).toContain("complete replacement");
  expect(request.messages[1]?.content).toEqual([{ type: "text", text: "return a + <|cursor|>" }]);
  const inline = ideTabRequest(input, model, "tab");
  expect(inline.messages[0]?.content).toContain("inline Tab completion");
  expect(inline.messages[0]?.content).not.toContain("replace_file_content");
  expect(ideTabRequest(input, model).reasoning_effort).toBeUndefined();
  expect(chatRequest(input, model.id).tools).toHaveLength(1);
});
it("returns success and error trailers in the client's RPC transport", async () => {
  const server = createServer((req, res) => {
    const contentType = req.url!.startsWith("/grpc") ? "application/grpc-web+json" : "application/connect+json";
    if (req.url!.endsWith("/error")) rpcError(res, contentType, "invalid_argument", "Invalid model");
    else rpcReply(res, contentType, { ok: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    for (const path of ["grpc", "connect"]) {
      const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${path}`)).arrayBuffer());
      const end = 5 + bytes.readUInt32BE(1);
      expect(JSON.parse(bytes.subarray(5, end).toString())).toEqual({ ok: true });
      expect(bytes[end]).toBe(path === "grpc" ? 128 : 2);
      expect(bytes.subarray(end + 5).toString()).toBe(path === "grpc" ? "grpc-status: 0\r\n" : "{}");
      const error = Buffer.from(await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${path}/error`)).arrayBuffer());
      expect(error[0]).toBe(path === "grpc" ? 128 : 2);
      if (path === "grpc") expect(error.subarray(5).toString()).toBe("grpc-status: 3\r\ngrpc-message: Invalid%20model\r\n");
      else expect(JSON.parse(error.subarray(5).toString())).toEqual({ error: { code: "invalid_argument", message: "Invalid model" } });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it("streams the first text before completion, assembles fragmented tool args, and cancels upstream", async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let disconnected!: () => void; const aborted = new Promise<void>(resolve => { disconnected = resolve; });
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    expect(req.headers.authorization).toBe("Bearer impact-key");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    if (input.model === "cancel") { res.once("close", disconnected); return; }
    await held;
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{\\\"path\\\":"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"a\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const connection = { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: Redacted.make("impact-key") };
  const proxy = createServer((req, res) => { const controller = new AbortController(); res.on("close", () => controller.abort()); void streamGeneration(connection, { model: req.url === "/cancel" ? "cancel" : "test", messages: [] }, res, controller.signal).catch(() => res.destroy()); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    const reader = (await fetch(base)).body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('"text":"first"');
    release(); let tail = ""; for (;;) { const item = await reader.read(); if (item.done) break; tail += new TextDecoder().decode(item.value); }
    expect(tail).toContain('"functionCall":{"id":"call_a","name":"read","args":{"path":"a"}}');
    expect(tail).toContain('"finishReason":"STOP"');
    const cancel = new AbortController(); const response = await fetch(base + "/cancel", { signal: cancel.signal });
    await response.body!.getReader().read(); cancel.abort(); await aborted;
  } finally { release(); proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
});

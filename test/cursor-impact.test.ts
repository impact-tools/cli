import { expect, it, vi } from "vitest";
import { CursorAccount } from "../src/clients/cursor/Account.ts";
import { impactRequest, streamChat } from "../src/clients/cursor/Impact.ts";
import { accountPayload, mockCursorImpact, modelsPayload, requestBody, sseEvent } from "./support/cursor-http.ts";

it("joins readable Impact names to Cursor capabilities by ID without adding unavailable models", async () => {
  const upstream = await mockCursorImpact((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.includes("flavor=anthropic")
      ? { data: [{ id: "impact-model", display_name: "Readable Impact Model" }, { id: "unavailable", display_name: "Hidden" }] }
      : req.url?.startsWith("/v1/models")
        ? { data: [{ id: "impact-model", capabilities: { supports_tool_use: true } }] }
        : accountPayload));
  });
  try {
    const loaded = await CursorAccount.load(upstream.connection, new AbortController().signal);
    expect(loaded.models).toEqual([{ id: "impact-model", display_name: "Readable Impact Model", capabilities: { supports_tool_use: true } }]);
    loaded.account.close();
  } finally { await upstream.close(); }
});

it("loads Impact identity/models, refreshes local credentials, expires and logs out without sending native tokens", async () => {
  let revoked = false;
  const auth: string[] = [];
  const upstream = await mockCursorImpact((req, res) => {
    auth.push(req.headers.authorization!);
    if (revoked) { res.writeHead(401); res.end("do not expose server secret"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.startsWith("/v1/models") ? modelsPayload : accountPayload));
  });
  try {
    const loaded = await CursorAccount.load(upstream.connection, new AbortController().signal);
    expect(loaded.account.id).toBe("impact-account");
    expect(loaded.account.email).toBe("person@example.test");
    expect(loaded.balance).toBe("42.5");
    expect(loaded.models[0]?.id).toBe("impact-model");
    expect(loaded.account.accepts(loaded.account.token)).toBe(true);
    expect(loaded.account.accepts(loaded.account.token + "forged")).toBe(false);
    expect(loaded.account.accepts("sk-imp-test-private")).toBe(false);
    const original = loaded.account.token;
    const refreshed = await loaded.account.refresh(loaded.account.refreshToken, new AbortController().signal);
    expect(refreshed.access_token).not.toBe(original);
    expect(loaded.account.accepts(refreshed.access_token)).toBe(true);
    const expiry = JSON.parse(Buffer.from(refreshed.access_token.split(".")[1]!, "base64url").toString()).exp;
    vi.spyOn(Date, "now").mockReturnValue((expiry + 1) * 1000);
    expect(loaded.account.accepts(refreshed.access_token)).toBe(false);
    vi.restoreAllMocks();
    revoked = true;
    await expect(loaded.account.refresh(loaded.account.refreshToken, new AbortController().signal)).rejects.toMatchObject({ code: "unauthenticated", message: "Impact answered HTTP 401." });
    loaded.account.close();
    expect(loaded.account.accepts(original)).toBe(false);
    await expect(loaded.account.refresh(loaded.account.refreshToken, new AbortController().signal)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(auth.every((value) => value === "Bearer sk-imp-test-private")).toBe(true);
  } finally { vi.restoreAllMocks(); await upstream.close(); }
});

it("parses fragmented UTF-8/CRLF SSE, keeping reasoning/tool argument fragments and finish/usage distinct", async () => {
  let received: unknown;
  const upstream = await mockCursorImpact((req, res) => {
    void requestBody(req).then((body) => {
      received = JSON.parse(body.toString());
      expect(req.headers.authorization).toBe("Bearer sk-imp-test-private");
      expect(req.headers["proxy-authorization"]).toBeUndefined();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { choices: [{ delta: { content: "Привет", reasoning_content: "think" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"main.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
      ].map(sseEvent).join("") + "data: [DONE]\r\n\r\n";
      const bytes = Buffer.from(events);
      let offset = 0;
      const fragment = () => { if (offset >= bytes.length) { res.end(); return; } res.write(bytes.subarray(offset, offset + 3)); offset += 3; setImmediate(fragment); };
      fragment();
    });
  });
  try {
    const deltas = [];
    for await (const delta of streamChat(upstream.connection, { model: "impact-model", messages: [{ role: "user", content: "read file" }] }, new AbortController().signal)) deltas.push(delta);
    expect(deltas).toEqual([
      { content: "Привет", reasoning: "think" },
      { toolCalls: [{ index: 0, id: "call-1", name: "read_file", arguments: '{"path":' }] },
      { toolCalls: [{ index: 0, id: undefined, name: undefined, arguments: '"main.ts"}' }], finishReason: "tool_calls" },
      { usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ]);
    expect(received).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "impact-model" });
  } finally { await upstream.close(); }
});

it("accepts multiline SSE data and rejects oversized events", async () => {
  let mode = "multiline";
  const upstream = await mockCursorImpact((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "multiline") {
      res.end(
        'data: {"choices":[\r\ndata: {"delta":{"content":"multi"},"finish_reason":null}],\r\ndata: "usage":null}\r\n\r\ndata: [DONE]\r\n\r\n',
      );
    } else {
      res.end(`data: ${"x".repeat(1024 * 1024 + 1)}\r\n\r\n`);
    }
  });
  const request = { model: "impact-model", messages: [] };
  try {
    const deltas = [];
    for await (const delta of streamChat(upstream.connection, request, new AbortController().signal)) deltas.push(delta);
    expect(deltas).toEqual([{ content: "multi" }]);
    mode = "oversized";
    const consume = async () => { for await (const _delta of streamChat(upstream.connection, request, new AbortController().signal)) {} };
    await expect(consume()).rejects.toMatchObject({ code: "resource_exhausted", message: "Impact event exceeds 1 MiB." });
  } finally { await upstream.close(); }
});

it("rejects malformed/truncated generation, origin escapes and credential revocation", async () => {
  let mode = "invalid";
  const upstream = await mockCursorImpact((_req, res) => {
    if (mode === "revoked") { res.writeHead(401); res.end("secret error"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(mode === "invalid" ? "data: {invalid}\r\n\r\n" : sseEvent({ choices: [{ delta: { content: "partial" } }] }));
  });
  const consume = async () => { for await (const _delta of streamChat(upstream.connection, { model: "impact-model", messages: [] }, new AbortController().signal)) {} };
  try {
    await expect(consume()).rejects.toMatchObject({ code: "data_loss" });
    mode = "truncated";
    await expect(consume()).rejects.toMatchObject({ code: "data_loss" });
    mode = "revoked";
    await expect(consume()).rejects.toMatchObject({ code: "unauthenticated", message: "Impact answered HTTP 401." });
    expect(() => impactRequest(upstream.connection, "https://evil.example/v1/models", undefined, new AbortController().signal)).toThrow("Invalid Impact route");
  } finally { await upstream.close(); }
});

it("cancels a pending generation and closes its upstream connection", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => began = resolve);
  let disconnected!: () => void;
  const ended = new Promise<void>((resolve) => disconnected = resolve);
  const upstream = await mockCursorImpact((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseEvent({ choices: [{ delta: { content: "waiting" } }] }));
    res.once("close", disconnected);
    began();
  });
  try {
    const controller = new AbortController();
    const consume = (async () => { for await (const _delta of streamChat(upstream.connection, { model: "impact-model", messages: [] }, controller.signal)) {} })();
    await started;
    controller.abort();
    await expect(consume).rejects.toMatchObject({ code: "canceled" });
    await ended;
  } finally { await upstream.close(); }
});

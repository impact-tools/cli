import { expect, it } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { CursorAccount } from "../src/clients/cursor/Account.ts";
import { createCursorNative } from "../src/clients/cursor/Native.ts";
import { CursorWire, decodeFrames, endFrame, frame } from "../src/clients/cursor/Wire.ts";
import { accountPayload, mockCursorImpact, modelsPayload, requestBody, sseEvent } from "./support/cursor-http.ts";

async function setupNative(catalog = modelsPayload) {
  const requests: Array<{ path: string; headers: Record<string, unknown>; body: Buffer }> = [];
  let revoked = false;
  let pending = false;
  let proxyAuthenticated = false;
  const upstream = await mockCursorImpact((request, response) => {
    void requestBody(request).then((body) => {
      requests.push({ path: request.url!, headers: request.headers, body });
      if (revoked) { response.writeHead(401); response.end(); return; }
      if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sseEvent({ choices: [{ delta: { content: "Impact answer" }, finish_reason: null }] }));
        if (!pending) response.end(sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\r\n\r\n");
      } else if (request.url?.endsWith("/StreamCpp")) {
        response.writeHead(200, { "content-type": "application/connect+proto" });
        response.end(Buffer.concat([frame(Buffer.from("tab-bytes")), endFrame()]));
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url?.startsWith("/v1/models") ? catalog : accountPayload));
      }
    });
  });
  const loaded = await CursorAccount.load(upstream.connection, new AbortController().signal);
  const wire = await CursorWire.load(new URL("./fixtures/cursor-app", import.meta.url).pathname);
  const native = createCursorNative(upstream.connection, loaded.account, loaded.models, wire);
  const server = createServer((request, response) => native.handler(request, response, "api2.cursor.sh", { proxyAuthenticated }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No native address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body: Buffer = Buffer.from("{}"), type = "application/json", token = loaded.account.token) => fetch(baseUrl + path, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type, cookie: "native-secret", "proxy-authorization": "Basic local-secret", "x-api-key": "native-secret", "x-cursor-client-version": "3.16.17", "x-session-id": "tab-session" }, body,
  });
  return {
    ...loaded, requests, wire, native, call, revoke() { revoked = true; }, pending() { pending = true; },
    authenticateProxy() { proxyAuthenticated = true; },
    withoutBearer(path: string) { return fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); },
    async close() { native.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await upstream.close(); },
  };
}

async function responseFrames(response: Response) {
  const result = [];
  const bytes = Buffer.from(await response.arrayBuffer());
  for await (const part of decodeFrames((async function* () { yield bytes; })())) result.push(part);
  return result;
}

it("returns Impact identity/models and local full-text Tab config without a Cursor session", async () => {
  const fixture = await setupNative();
  try {
    const me = await fixture.call("/api/auth/me");
    expect(await me.json()).toEqual({ id: "impact-account", email: "person@example.test" });
    const profile = await fixture.call("/auth/full_stripe_profile");
    expect(await profile.json()).toEqual({ membershipType: "pro", subscriptionStatus: "active", email: "Impact · person@example.test", lastPaymentFailed: false });
    const models = await fixture.call("/aiserver.v1.AiService/AvailableModels");
    expect(await models.json()).toMatchObject({ modelNames: ["impact-model"], models: [{ name: "impact-model", clientDisplayName: "Impact Model", supportsAgent: true }] });
    const email = await fixture.call("/aiserver.v1.AuthService/GetEmail");
    expect(await email.json()).toEqual({ email: "Impact · person@example.test" });
    const cpp = await fixture.call("/aiserver.v1.AiService/CppConfig", Buffer.alloc(0), "application/proto");
    const config = fixture.wire.decode("fixture.Cpp", Buffer.from(await cpp.arrayBuffer()));
    expect(config.isOn).toBe(true);
    expect(config.shouldFetchRvfText).toBe(true);
    expect(config.allowsTabChunks).toBe(false);
    expect(config.cppUrl).toBe("https://api3.cursor.sh");
    const sync = await fixture.call("/aiserver.v1.FileSyncService/FSIsEnabledForUser");
    expect(await sync.json()).toEqual({}); // proto3 omits the explicit false default.
    expect(fixture.requests).toHaveLength(3); // Initial account/catalog and readable names: native replies stay local.
  } finally { await fixture.close(); }
});

it("allows omitted origin authentication only on an authenticated live CONNECT capability", async () => {
  const fixture = await setupNative();
  const path = "/aiserver.v1.AuthService/GetEmail";
  try {
    expect((await fixture.withoutBearer(path)).status).toBe(401);
    fixture.authenticateProxy();
    const accepted = await fixture.withoutBearer(path);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ email: "Impact · person@example.test" });
    expect((await fixture.call(path, Buffer.from("{}"), "application/json", "wrong-token")).status).toBe(401);
    fixture.account.close();
    expect((await fixture.withoutBearer(path)).status).toBe(401);
    expect(fixture.requests).toHaveLength(3);
  } finally { await fixture.close(); }
});

it("rejects a second unary Connect request before expanding later frames", async () => {
  const fixture = await setupNative();
  try {
    const body = Buffer.concat([frame(Buffer.from("{}")), frame(Buffer.from("{}")), frame(Buffer.from("invalid-gzip"), 1)]);
    const response = await fixture.call("/aiserver.v1.AuthService/GetEmail", body, "application/connect+json");
    const frames = await responseFrames(response);
    expect(JSON.parse(frames.at(-1)!.payload.toString())).toEqual({ error: { code: "invalid_argument", message: "Send one native request frame." } });
    expect(fixture.requests).toHaveLength(3);
  } finally { await fixture.close(); }
});

it("translates Connect protobuf chat and keeps native credentials away from Impact", async () => {
  const fixture = await setupNative();
  try {
    const message = fixture.wire.encode("fixture.Chat", { modelDetails: { modelName: "impact-model" }, conversation: [{ type: 1, text: "Hello" }, { type: 2, text: "Previous reply" }, { type: 1, text: "Continue" }] });
    const response = await fixture.call("/aiserver.v1.AiService/StreamChat", frame(message), "application/connect+proto");
    expect(response.status).toBe(200);
    const frames = await responseFrames(response);
    expect(fixture.wire.decode("fixture.ChatOutput", frames[0]!.payload).text).toBe("Impact answer");
    expect(frames.at(-1)?.flags).toBe(2);
    expect(JSON.parse(frames.at(-1)!.payload.toString())).toEqual({});
    const generation = fixture.requests.find((request) => request.path === "/v1/chat/completions")!;
    expect(JSON.parse(generation.body.toString())).toMatchObject({ model: "impact-model", messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Previous reply" }, { role: "user", content: "Continue" }] });
    expect(generation.headers.authorization).toBe("Bearer sk-imp-test-private");
    for (const header of ["cookie", "proxy-authorization", "x-api-key", "x-cursor-team-id"]) expect(generation.headers[header]).toBeUndefined();
    expect(generation.body.toString()).not.toContain(fixture.account.token);
  } finally { await fixture.close(); }
});

it("passes Tab Connect bytes unchanged while replacing credentials", async () => {
  const fixture = await setupNative();
  try {
    const bytes = frame(Buffer.from("native-tab-request"));
    const response = await fixture.call("/aiserver.v1.AiService/StreamCpp", bytes, "application/connect+proto");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat([frame(Buffer.from("tab-bytes")), endFrame()]));
    const request = fixture.requests.find((seen) => seen.path.endsWith("/StreamCpp"))!;
    expect(request.body).toEqual(bytes);
    expect(request.headers.authorization).toBe("Bearer sk-imp-test-private");
    expect(request.headers["connect-protocol-version"]).toBe("1");
    expect(request.headers["x-cursor-client-version"]).toBe("3.16.17");
    expect(request.headers["x-session-id"]).toBe("tab-session");
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers["proxy-authorization"]).toBeUndefined();
  } finally { await fixture.close(); }
});

it("uses the installed Cursor version when the Tab caller omits it", async () => {
  const fixture = await setupNative();
  fixture.wire.clientVersion = "3.22.12";
  try {
    const server = createServer((req, res) => {
      delete req.headers["x-cursor-client-version"];
      fixture.native.handler(req, res, "api2.cursor.sh");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/aiserver.v1.AiService/StreamCpp`, {
        method: "POST", headers: { authorization: `Bearer ${fixture.account.token}`, "content-type": "application/connect+proto" }, body: frame(Buffer.from("tab")),
      });
      await response.arrayBuffer();
      expect(fixture.requests.find(r => r.path.endsWith("/StreamCpp"))?.headers["x-cursor-client-version"]).toBe("3.22.12");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await fixture.close(); }
});

it("fails unknown RPCs, unknown models, invalid sessions and revoked upstream keys explicitly", async () => {
  const fixture = await setupNative();
  try {
    expect((await fixture.call("/aiserver.v1.AiService/DoesNotExist")).status).toBe(501);
    expect(await (await fixture.call("/aiserver.v1.AiService/Unsupported")).json()).toMatchObject({ code: "unimplemented" });
    expect((await fixture.call("/api/auth/me", undefined, undefined, "forged")).status).toBe(401);
    const badModel = fixture.wire.encode("fixture.Chat", { modelDetails: { modelName: "cursor-only-model" }, conversation: [{ type: 1, text: "Hello" }] });
    const denied = await fixture.call("/aiserver.v1.AiService/StreamChat", frame(badModel), "application/connect+proto");
    expect(JSON.parse((await responseFrames(denied)).at(-1)!.payload.toString()).error.code).toBe("invalid_argument");
    fixture.revoke();
    const chat = fixture.wire.encode("fixture.Chat", { modelDetails: { modelName: "impact-model" }, conversation: [{ type: 1, text: "Hello" }] });
    const revoked = await fixture.call("/aiserver.v1.AiService/StreamChat", frame(chat), "application/connect+proto");
    expect(JSON.parse((await responseFrames(revoked)).at(-1)!.payload.toString()).error.code).toBe("unauthenticated");
    fixture.native.close();
    expect((await fixture.call("/api/auth/me")).status).toBe(401);
  } finally { await fixture.close(); }
});

it("closes an ongoing native chat and cancels upstream generation", async () => {
  const fixture = await setupNative();
  try {
    fixture.pending();
    const chat = fixture.wire.encode("fixture.Chat", { conversation: [{ type: 1, text: "Hello" }] });
    const response = await fixture.call("/aiserver.v1.AiService/StreamChat", frame(chat), "application/connect+proto");
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    fixture.native.close();
    const chunks = [];
    for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); }
    const frames = [];
    for await (const part of decodeFrames((async function* () { yield Buffer.concat(chunks); })())) frames.push(part);
    expect(JSON.parse(frames.at(-1)!.payload.toString()).error.code).toBe("canceled");
  } finally { await fixture.close(); }
});


it("includes every Impact model in named picker sections over protobuf", async () => {
  const fixture = await setupNative({ data: [
    ...modelsPayload.data,
    { ...modelsPayload.data[0]!, id: "second-model", display_name: "Second Model" },
  ] });
  try {
    const response = await fixture.call("/aiserver.v1.AiService/AvailableModels", Buffer.alloc(0), "application/proto");
    const catalog = fixture.wire.decode("aiserver.v1.AvailableModelsResponse", Buffer.from(await response.arrayBuffer()));
    expect(catalog.modelNames).toEqual(["impact-model", "second-model"]);
    expect(catalog.models.filter((model: { namedModelSectionIndex?: number }) => model.namedModelSectionIndex !== undefined)
      .map((model: { name: string }) => model.name)).toEqual(catalog.modelNames);
  } finally { await fixture.close(); }
});

it("writes commit messages on the cheapest preferred model", async () => {
  const fixture = await setupNative({ data: [...modelsPayload.data, { id: "claude-haiku-5-5", display_name: "Haiku", context_length: 64000, capabilities: [] }] });
  try {
    const body = fixture.wire.encode("aiserver.v1.WriteGitCommitMessageRequest", { diffs: ["+added line"], previousCommitMessages: ["fix: older"] });
    const response = await fixture.call("/aiserver.v1.AiService/WriteGitCommitMessage", Buffer.from(body), "application/proto");
    expect(response.status).toBe(200);
    expect(fixture.wire.decode("aiserver.v1.WriteGitCommitMessageResponse", Buffer.from(await response.arrayBuffer())).commitMessage).toBe("Impact answer");
    const generation = fixture.requests.find((request) => request.path === "/v1/chat/completions")!;
    expect(JSON.parse(generation.body.toString())).toMatchObject({ model: "claude-haiku-5-5" });
    expect(generation.body.toString()).toContain("+added line");
  } finally { await fixture.close(); }
});

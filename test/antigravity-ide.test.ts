import { Redacted } from "effect";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { accessToken } from "../src/clients/antigravity/Bridge.ts";
import { createAntigravityIde, IDE_SESSION } from "../src/clients/antigravity/Ide.ts";

it("authenticates IDE refresh and cloud routes, restores model choice, and streams wrapped tool events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "impact-ide-test-"));
  const upstreamBodies: any[] = [];
  let catalogRequests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let cancelObserved!: () => void;
  const canceled = new Promise<void>(resolve => { cancelObserved = resolve; });
  const upstream = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer impact-key");
    if (req.url?.startsWith("/v1/models")) {
      catalogRequests++;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [
        { id: "first", display_name: "First Model", max_output_tokens: 1024 },
        { id: "second", display_name: "Second Model", max_output_tokens: 2048, capabilities: { image_input: { supported: true } } },
      ] }));
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); upstreamBodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"first chunk"}}]}\n\n');
    if (body.model === "first") { res.once("close", cancelObserved); return; }
    await held;
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  let connection = { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: Redacted.make("impact-key") };
  const options = { key: "daemon-key", directory, login: async () => connection, identity: async () => ({ id: "ada", email: "ada@example.com" }) };
  let bridge = createAntigravityIde(options);
  // The test header stands for the CONNECT destination validated by HttpsProxy.
  const proxy = createServer((req, res) => bridge.handle(req, res, req.headers["x-test-host"] === "registration" ? "" : req.headers["x-test-host"] as string));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const token = accessToken(options.key, connection);
  const request = (host: string, path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init, headers: { "x-test-host": host, authorization: `Bearer ${token}`, ...init.headers },
  });
  const post = (host: string, path: string, body: unknown) => request(host, path, { method: "POST", body: JSON.stringify(body) });
  try {
    for (const refresh of ["google-refresh-token", "", token]) {
      const res = await request("oauth2.googleapis.com", "/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }), headers: { authorization: "" } });
      expect(res.status).toBe(refresh === token ? 200 : 401);
      if (refresh === token) expect(await res.json()).toMatchObject({ access_token: token, refresh_token: token });
      else await res.text();
    }
    expect(catalogRequests).toBe(0);
    const invalid = await request("cloudcode-pa.googleapis.com", "/v1internal:fetchAvailableModels", { method: "POST", headers: { authorization: "Bearer google-token" } });
    expect(invalid.status).toBe(401); await invalid.text();
    const blockedOrigin = await request("www.googleapis.com", "/oauth2/v2/userinfo", { headers: { origin: "https://untrusted.test" } });
    expect(blockedOrigin.status).toBe(403); await blockedOrigin.text();
    expect(await (await request("www.googleapis.com", "/oauth2/v2/userinfo")).json()).toMatchObject({ id: "ada", email: "ada@example.com" });
    const registered = await post("registration", IDE_SESSION, { model: "second" });
    expect(registered.status).toBe(200); await registered.text();
    const saved = await readFile(join(directory, "antigravity-ide-session.json"), "utf8");
    expect(saved).not.toContain("impact-key"); expect(saved).not.toContain(token);
    bridge = createAntigravityIde(options);
    const catalog: any = await (await post("daily-cloudcode-pa.googleapis.com", "/v1internal:fetchAvailableModels", {})).json();
    expect(catalog.defaultAgentModelId).toBe("second");
    expect(catalog.models.second).toMatchObject({ displayName: "Second Model", supportsImages: true });
    expect(catalog.models.first.model).not.toBe(catalog.models.second.model);
    const generation = { model: "impact-background-1036", request: { systemInstruction: { parts: [{ text: "system once" }] }, contents: [{ role: "user", parts: [{ text: "complete" }] }] } };
    const reader = (await post("daily-cloudcode-pa.googleapis.com", "/v1internal:streamGenerateContent?alt=sse", generation)).body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first.slice(6)).response.candidates[0].content.parts).toEqual([{ text: "first chunk" }]);
    expect(upstreamBodies[0]).toMatchObject({ model: "second", messages: [{ role: "system", content: "system once" }, { role: "user" }] });
    release(); let tail = "";
    for (;;) { const item = await reader.read(); if (item.done) break; tail += new TextDecoder().decode(item.value); }
    const last = JSON.parse(tail.trim().slice(6));
    expect(last.response.candidates[0]).toMatchObject({ finishReason: "STOP", content: { parts: [{ functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } } }] } });
    const controller = new AbortController();
    const pending = await request("cloudcode-pa.googleapis.com", "/v1internal:streamGenerateContent", { method: "POST", signal: controller.signal, body: JSON.stringify({ ...generation, model: "first" }) });
    await pending.body!.getReader().read(); controller.abort(); await canceled;
    const unknown = await post("cloudcode-pa.googleapis.com", "/v1internal:streamGenerateContent", { ...generation, model: "missing" });
    expect(unknown.status).toBe(400); await unknown.text();
    const features = await request("antigravity-unleash.goog", "/api/client/features", { headers: { authorization: "built-in-sdk-key" } });
    expect(await features.json()).toEqual({ version: 1, features: [] });
    expect((await request("antigravity-unleash.goog", "/api/client/register", { method: "POST", headers: { authorization: "" } })).status).toBe(204);
    const log = await post("play.googleapis.com", "/log", {}); expect(await log.text()).toBe("");
    connection = { ...connection, apiKey: Redacted.make("new-login") };
    const stale = await request("www.googleapis.com", "/oauth2/v2/userinfo"); expect(stale.status).toBe(401); await stale.text();
    const staleRefresh = await request("oauth2.googleapis.com", "/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }) });
    expect(staleRefresh.status).toBe(401); await staleRefresh.text();
  } finally {
    release(); proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
  }
});

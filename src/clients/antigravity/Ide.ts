import { Schema } from "effect";
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Http2ServerRequest } from "node:http2";
import { join } from "node:path";

import type { Connection } from "../../config/Connection.ts";
import { loginId } from "../../auth/Identity.ts";
import type { NativeHandler } from "../cursor/HttpsProxy.ts";
import { ProtocolError } from "../cursor/Impact.ts";
import { accessToken, readBody } from "./Bridge.ts";
import { chatRequest, streamGeneration, writeEvent, type GatewayResponse } from "./Gateway.ts";
import { loadModels, supportsImages, type GatewayModel } from "./Models.ts";
import { IDE_CLOUD_HOSTS, IDE_PROXY_HOSTS } from "./Tls.ts";

export const IDE_SESSION = "/impact-antigravity/ide/session";
const readSession = Schema.decodeUnknownSync(Schema.Struct({ model: Schema.optional(Schema.String) }));
const readRegistration = Schema.decodeUnknownSync(Schema.Struct({ model: Schema.optional(Schema.String), login: Schema.String }));
const readGeneration = Schema.decodeUnknownSync(Schema.Struct({ model: Schema.String, request: Schema.Unknown, requestType: Schema.optional(Schema.String) }));
const equal = (given: string, expected: string) => {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
type Request = IncomingMessage | Http2ServerRequest;
type Response = GatewayResponse;
const json = (res: Response, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

// The stock server calls these enum keys even when a custom model is selected.
const backgroundModels = { "impact-background-1036": 1036, "gemini-3.1-flash-lite": 1050, "impact-tab": 312 };
export function ideCatalog(models: readonly GatewayModel[], selected: GatewayModel) {
  const details = (model: GatewayModel, key = model.key) => ({
    displayName: model.label, model: key,
    maxTokens: model.context_length ?? model.max_input_tokens ?? 128_000,
    maxOutputTokens: Math.min(model.max_output_tokens ?? model.max_tokens ?? 8192, 65_536),
    apiProvider: 24, toolFormatterType: key === 312 ? 3 : 5,
    ...(key === 312 ? { supportsCumulativeContext: true } : {}),
    supportsImages: supportsImages(model),
  });
  return {
    models: Object.fromEntries([
      ...Object.entries(backgroundModels).map(([id, key]) => [id, details(selected, key)]),
      ...models.map(model => [model.id, details(model)]),
    ]),
    defaultAgentModelId: selected.id,
    agentModelSorts: [{ displayName: "Recommended", groups: [{ displayName: "Impact", modelIds: models.map(m => m.id) }] }],
    commandModelIds: ["impact-tab"], tabModelIds: ["impact-tab"], commitMessageModelIds: [selected.id],
  };
}

/** Adapt native inline Tab and Tab Jump requests to their different completion contracts. */
export function ideTabRequest(body: unknown, model: GatewayModel, requestType: string = "tab_jump") {
  const request = chatRequest(body, model.id, model.max_output_tokens ?? model.max_tokens);
  const format = requestType === "tab"
    ? "This is an inline Tab completion. Output only the exact text to insert at the <|cursor|> marker in the LAST user message. Do not output the marker, surrounding code, XML, markdown, tool tags, or an explanation. Return only a concise syntactic continuation, preserving the file's indentation."
    : "This is a Tab Jump completion. Call replace_file_content exactly once with exactly one ReplacementChunk. TargetContent must be the ENTIRE mentioned Text Block from the LAST user message, with the <|cursor|> marker removed. EXCLUDE the trailing newline after the final code line from TargetContent and ReplacementContent. Preserve all other characters and newlines. ReplacementContent must be that entire block as a complete replacement with the next small edit applied. Do not target only the changed line or a substring: the Tab parser matches the entire block exactly. Follow the provided XML tool format. Output only the tool call, without explanation.";
  const system = request.messages.find(message => message.role === "system");
  if (system) system.content = `${system.content}\n\n${format}`;
  else request.messages.unshift({ role: "system", content: format });
  const effort = ["none", "minimal", "low"].find(value => model.reasoning_efforts?.includes(value));
  if (effort) request.reasoning_effort = effort;
  return request;
}

/** The IDE owns its language servers and profile. Only its authenticated cloud requests are adapted. */
export function createAntigravityIde(options: {
  key: string; directory: string; login(): Promise<Connection>;
  identity(connection: Connection): Promise<{ id: string; email: string }>;
}) {
  const registration = join(options.directory, "antigravity-ide-session.json");
  let cached: { login: string; at: number; value: Promise<{ models: GatewayModel[]; selected: GatewayModel }> } | undefined;
  const catalog = (connection: Connection) => {
    const login = loginId(connection);
    if (cached?.login === login && Date.now() - cached.at < 60_000) return cached.value;
    const value = (async () => {
      const saved = await readFile(registration, "utf8").then(text => readRegistration(JSON.parse(text))).catch(() => undefined);
      const models = await loadModels(connection);
      const selected = models.find(m => m.id === (saved?.login === login ? saved.model : undefined)) ?? models[0]!;
      return { models, selected };
    })();
    cached = { login, at: Date.now(), value };
    value.catch(() => { if (cached?.value === value) cached = undefined; });
    return value;
  };
  const dispatch = async (req: Request, res: Response, host?: string) => {
    const path = new URL(req.url ?? "/", "https://127.0.0.1").pathname;
    if (host ? !IDE_PROXY_HOSTS.has(host) : path !== IDE_SESSION) { req.resume(); return json(res, 404, { error: { message: "Unknown Antigravity IDE route." } }); }
    if (req.headers.origin && !req.headers.origin.startsWith("vscode-file://")) throw new ProtocolError("permission_denied", "Invalid origin.");
    // The native SDK uses its built-in feature-service credential, not the user's
    // OAuth token. These static responses disclose no Impact account information.
    if (host === "antigravity-unleash.goog") {
      req.resume();
      if (req.method === "GET" && path === "/api/client/features") return json(res, 200, { version: 1, features: [] });
      if (req.method === "POST" && (path === "/api/client/register" || path === "/api/client/metrics")) { res.writeHead(204, {}); return res.end(); }
      return json(res, 404, { error: { message: "Unknown feature-service route." } });
    }
    const connection = await options.login();
    const token = accessToken(options.key, connection);
    if (host === "oauth2.googleapis.com" && path === "/token" && req.method === "POST") {
      const body = new URLSearchParams((await readBody(req, 16384)).toString());
      if (body.get("grant_type") !== "refresh_token" || !equal(body.get("refresh_token") ?? "", token))
        throw new ProtocolError("unauthenticated", "Run impact antigravity to connect your Impact account.");
      return json(res, 200, { access_token: token, refresh_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    if (!equal(req.headers.authorization?.replace(/^Bearer /, "") ?? "", token))
      throw new ProtocolError("unauthenticated", "Run impact antigravity to connect your Impact account.");
    if (!host && req.method === "POST") {
      let input: ReturnType<typeof readSession>;
      try { input = readSession(JSON.parse((await readBody(req, 16384)).toString())); }
      catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity IDE session."); }
      const models = await loadModels(connection);
      const selected = input.model ? models.find(m => m.id === input.model) : models[0];
      if (!selected) throw new ProtocolError("invalid_argument", `Model ${input.model} is unavailable in Impact.`);
      await writeFile(registration + ".tmp", JSON.stringify({ model: selected.id, login: loginId(connection) }), { mode: 0o600 });
      await rename(registration + ".tmp", registration);
      cached = { login: loginId(connection), at: Date.now(), value: Promise.resolve({ models, selected }) };
      return json(res, 200, { models: models.length, model: selected.label });
    }
    if (host === "www.googleapis.com" && path === "/oauth2/v2/userinfo" && req.method === "GET") {
      req.resume(); const account = await options.identity(connection);
      return json(res, 200, { id: account.id, email: account.email, name: "Impact", verified_email: true });
    }
    if (host && IDE_CLOUD_HOSTS.has(host)) {
      if (req.method === "POST" && path === "/v1internal:streamGenerateContent") {
        let input: ReturnType<typeof readGeneration>;
        try { input = readGeneration(JSON.parse((await readBody(req)).toString())); }
        catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity IDE generation request."); }
        const { models, selected } = await catalog(connection);
        const model = models.find(m => m.id === input.model) ?? (Object.hasOwn(backgroundModels, input.model) ? selected : undefined);
        if (!model) throw new ProtocolError("invalid_argument", `Model ${input.model ?? "default"} is unavailable in Impact.`);
        const controller = new AbortController(); res.once("close", () => controller.abort());
        const generation = input.model === "impact-tab" ? ideTabRequest(input.request, model, input.requestType) : chatRequest(input.request, model.id, model.max_output_tokens ?? model.max_tokens);
        return streamGeneration(connection, generation, res, controller.signal, response => ({ response }));
      }
      req.resume();
      if (req.method === "POST") switch (path) {
        case "/v1internal:loadCodeAssist": return json(res, 200, { cloudaicompanionProject: "impact-local", currentTier: { id: "impact", name: "Impact" }, paidTier: { id: "impact", name: "Impact", usesGcpTos: false }, allowedTiers: [{ id: "impact", name: "Impact", isDefault: true }] });
        case "/v1internal:fetchAvailableModels": { const { models, selected } = await catalog(connection); return json(res, 200, ideCatalog(models, selected)); }
        case "/v1internal:fetchUserInfo": return json(res, 200, { userSettings: { telemetryEnabled: false } });
        case "/v1internal:onboardUser": return json(res, 200, { done: true, response: { cloudaicompanionProject: { id: "impact-local" } } });
        case "/v1internal:fetchAdminControls": case "/v1internal:listExperiments": case "/v1internal:recordCodeAssistMetrics": return json(res, 200, {});
        case "/v1internal:retrieveUserQuotaSummary": return json(res, 200, { groups: [] });
      }
      if (path === "/v1internal/cascadeNuxes" && req.method === "GET") return json(res, 200, {});
      if (path === "/v1internal/buildWithGooglePlugins" && req.method === "GET") return json(res, 200, { buildWithGooglePlugins: [] });
    }
    req.resume();
    if (host === "play.googleapis.com" && path === "/log" && req.method === "POST") { res.writeHead(200, {}); return res.end(); }
    return json(res, 404, { error: { code: 404, message: `Unsupported Antigravity IDE route: ${path}`, status: "UNIMPLEMENTED" } });
  };
  const handle: NativeHandler = (req, res, host) => {
    void dispatch(req, res, host || undefined).catch(async error => {
      req.resume(); if (res.destroyed) return;
      const known = error instanceof ProtocolError;
      const message = known ? error.message : "Cannot complete the Antigravity IDE request. Check impact proxy status.";
      const code = known ? error.code : "unavailable";
      const status = code === "unauthenticated" ? 401 : code === "permission_denied" ? 403 : code === "invalid_argument" ? 400 : 502;
      const body = { error: { code: status, message, status: code.toUpperCase() } };
      if (res.headersSent) { await writeEvent(res, body, new AbortController().signal).catch(() => {}); res.end(); }
      else json(res, status, body);
    });
  };
  return { handle };
}

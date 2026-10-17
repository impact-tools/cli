import { Schema } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";

import type { Connection } from "../../config/Connection.ts";
import { loginId } from "../../auth/Identity.ts";
import { ProtocolError } from "../cursor/Impact.ts";
import { chatRequest, streamGeneration, writeEvent } from "./Gateway.ts";
import { loadModels, nativeCatalog, nativeModel, type GatewayModel } from "./Models.ts";
import { startLanguageServer, type AntigravityRuntime } from "./Runtime.ts";

export const SESSION = "/impact-antigravity/session";
export const GATEWAY = "/impact-antigravity/gateway";
export const accessToken = (key: string, connection: Connection) => createHmac("sha256", key).update(`antigravity:${loginId(connection)}`).digest("base64url");
const equal = (given: string, expected: string) => { const a = Buffer.from(given), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); };
const SessionRequest = Schema.Struct({ executable: Schema.String, version: Schema.String, model: Schema.optional(Schema.String) });
const readSession = Schema.decodeUnknownSync(SessionRequest);
const readRegistration = Schema.decodeUnknownSync(Schema.Struct({ ...SessionRequest.fields, login: Schema.String }));
const readObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const object = (value: unknown): Record<string, unknown> => { try { return readObject(value); } catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity RPC object."); } };
export const requestJson = (body: Buffer) => {
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity request JSON."); }
};
export const upstreamJson = (body: Buffer) => {
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new ProtocolError("data_loss", "Antigravity's language server returned invalid JSON."); }
};
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
export async function readBody(request: AsyncIterable<Uint8Array>, limit = 4 * 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new ProtocolError("resource_exhausted", "Antigravity request exceeds 4 MiB."); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
const frame = (body: Buffer, flags = 0) => { const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); };
export const rpcBody = (body: Buffer, contentType: string): unknown => {
  if (/grpc-web|connect\+json/.test(contentType)) {
    if (body.length < 5 || body[0] !== 0 || body.readUInt32BE(1) !== body.length - 5) throw new ProtocolError("invalid_argument", "Unsupported Antigravity RPC frame.");
    body = body.subarray(5);
  }
  try { return JSON.parse(body.toString("utf8")); } catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity RPC JSON."); }
};
export const rpcReply = (response: ServerResponse, contentType: string, body: unknown, status = 200) => {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": contentType || "application/json", "cache-control": "no-store" });
  if (contentType.includes("grpc-web")) response.end(Buffer.concat([frame(encoded), frame(Buffer.from("grpc-status: 0\r\n"), 128)]));
  else if (contentType.includes("connect+json")) response.end(Buffer.concat([frame(encoded), frame(Buffer.from("{}"), 2)]));
  else response.end(encoded);
};
const codes: Record<string, number> = { canceled: 1, invalid_argument: 3, deadline_exceeded: 4, unauthenticated: 16, permission_denied: 7, resource_exhausted: 8, failed_precondition: 9, unimplemented: 12, unavailable: 14, data_loss: 15 };
export const rpcError = (response: ServerResponse, contentType: string, code: string, message: string) => {
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  if (contentType.includes("grpc-web")) response.end(frame(Buffer.from(`grpc-status: ${codes[code] ?? 13}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`), 128));
  else response.end(frame(Buffer.from(JSON.stringify({ error: { code, message } })), 2));
};
const fail = (req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string) => {
  req.resume();
  const contentType = String(req.headers["content-type"] ?? "");
  if (/grpc-web|connect\+json/.test(contentType)) return rpcError(res, contentType, code, message);
  json(res, status, { error: { code: status, message, status: code.toUpperCase() } });
};

export function adaptMessage(body: unknown, models: readonly GatewayModel[], fallback: GatewayModel): unknown {
  const input = object(body);
  const config = object(input.cascadeConfig ?? input.overrideConfig ?? {});
  const planner = object(config.plannerConfig ?? {});
  const model = models.find(m => m.key === planner.planModel) ?? models.find(m => m.id === object(planner.customModelInfoOverride ?? {}).modelName) ?? fallback;
  const adapted = { ...config, plannerConfig: { ...planner, planModel: 326, requestedModel: { model: 326 }, customModelInfoOverride: nativeModel(model) } };
  return { ...input, ["overrideConfig" in input ? "overrideConfig" : "cascadeConfig"]: adapted };
}

interface Session { runtime: AntigravityRuntime; models: GatewayModel[]; selected: GatewayModel; login: string; executable: string; version: string }
export function createAntigravityBridge(options: { origin: string; ca: string; key: string; directory: string; login(): Promise<Connection> }) {
  let session: Session | undefined;
  let preparing: Promise<Session> | undefined;
  let closed = false;
  const registration = join(options.directory, "antigravity-session.json");
  const forward = httpProxy.createProxyServer({ toProxy: true, changeOrigin: true, ws: true });
  forward.on("error", (_error, request, response) => { if ("writeHead" in response && !response.headersSent) fail(request, response as ServerResponse, 502, "unavailable", "Antigravity's language server is unavailable. Retry the request."); else response.destroy(); });
  forward.on("proxyReq", (outgoing) => {
    for (const header of ["cookie", "authorization", "chatgpt-account-id", "openai-organization", "x-api-key", "proxy-authorization"])
      outgoing.removeHeader(header);
  });
  forward.on("proxyReqWs", (outgoing) => {
    for (const header of ["cookie", "authorization", "chatgpt-account-id", "openai-organization", "x-api-key", "proxy-authorization"])
      outgoing.removeHeader(header);
  });
  const target = (runtime: AntigravityRuntime) => { const url = new URL(runtime.origin); return { protocol: "http:", host: "127.0.0.1", hostname: "127.0.0.1", port: url.port }; };
  const scrubIncoming = (request: IncomingMessage) => {
    for (const header of ["cookie", "authorization", "chatgpt-account-id", "openai-organization", "x-api-key", "proxy-authorization", "expect"])
      delete request.headers[header];
  };
  const prepare = async (body: unknown, connection: Connection, refresh = true): Promise<Session> => {
    let input: typeof SessionRequest.Type;
    try { input = readSession(body); } catch { throw new ProtocolError("invalid_argument", "Invalid Antigravity session request."); }
    const id = loginId(connection);
    while (preparing) await preparing;
    if (closed) throw new ProtocolError("unavailable", "The Impact proxy is stopping.");
    if (session?.login === id && session.executable === input.executable && session.version === input.version && session.runtime.child.exitCode === null && !session.runtime.child.killed) {
      if (!refresh) return session;
    }
    preparing = (async () => {
      const models = await loadModels(connection);
      const selected = models.find(m => m.id === input.model) ?? (input.model ? undefined : models[0]);
      if (!selected) throw new ProtocolError("invalid_argument", `Model ${input.model} is unavailable in Impact.`);
      if (session?.login === id && session.executable === input.executable && session.version === input.version && session.runtime.child.exitCode === null && !session.runtime.child.killed) {
        session.models = models; session.selected = selected;
      } else {
        await session?.runtime.close(); session = undefined;
        const runtime = await startLanguageServer({ executable: input.executable, version: input.version, gateway: options.origin + GATEWAY, token: accessToken(options.key, connection), ca: options.ca, log: join(options.directory, "antigravity.log") });
        if (closed) { await runtime.close(); throw new ProtocolError("unavailable", "The Impact proxy is stopping."); }
        session = { runtime, models, selected, login: id, executable: input.executable, version: input.version };
      }
      // Only the authenticated launcher registers an executable. Startup remains independent of clients.
      await writeFile(registration + ".tmp", JSON.stringify({ ...input, login: id }), { mode: 0o600 });
      await rename(registration + ".tmp", registration);
      return session;
    })();
    try { return await preparing; } finally { preparing = undefined; }
  };
  const restore = async (connection: Connection) => {
    if (session?.login === loginId(connection) && session.runtime.child.exitCode === null && !session.runtime.child.killed) return session;
    const saved = await readFile(registration, "utf8").then(text => readRegistration(JSON.parse(text))).catch(() => undefined);
    if (!saved || saved.login !== loginId(connection)) throw new ProtocolError("failed_precondition", "Run impact antigravity to start the language server.");
    return prepare(saved, connection, false);
  };
  const authentic = (req: IncomingMessage, connection: Connection) => {
    const token = accessToken(options.key, connection);
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const cookie = req.headers.cookie?.split(/;\s*/).find(v => v.startsWith("impact_antigravity="))?.slice("impact_antigravity=".length) ?? "";
    return req.headers.authorization ? equal(bearer, token) : equal(cookie, token);
  };
  const call = async (runtime: AntigravityRuntime, path: string, body: unknown, signal: AbortSignal) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(runtime.origin + path, { method: "POST", signal, headers: { "content-type": "application/json", "content-length": bytes.length, "x-codeium-csrf-token": runtime.csrf } }, resolve);
      outgoing.on("error", reject); outgoing.end(bytes);
    });
  };
  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", options.origin);
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const connection = await options.login();
    if (url.pathname === "/impact-antigravity/open" && req.method === "GET") {
      if (!equal(url.searchParams.get("token") ?? "", accessToken(options.key, connection))) return json(res, 401, { error: "Run impact antigravity to connect." });
      res.writeHead(303, { location: "/", "set-cookie": `impact_antigravity=${accessToken(options.key, connection)}; HttpOnly; Secure; SameSite=Strict; Path=/`, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(); return;
    }
    if (!authentic(req, connection)) return fail(req, res, 401, "unauthenticated", "Run impact antigravity to connect.");
    if (req.headers.origin && req.headers.origin !== options.origin) return fail(req, res, 403, "permission_denied", "Invalid origin.");
    if (url.pathname === SESSION && req.method === "POST") {
      const prepared = await prepare(requestJson(await readBody(req, 16384)), connection);
      return json(res, 200, { models: prepared.models.length, model: prepared.selected.label });
    }
    const current = await restore(connection);
    if (url.pathname.startsWith(GATEWAY)) {
      const match = new RegExp(`^${GATEWAY}/v1beta/models/(.+):streamGenerateContent$`).exec(url.pathname);
      if (req.method !== "POST" || !match) { req.resume(); return json(res, 404, { error: "Unsupported Antigravity gateway route." }); }
      const id = decodeURIComponent(match[1]!);
      const model = current.models.find(m => m.id === id) ?? (id === "gemini-3.1-flash-lite" ? current.selected : undefined);
      if (!model) throw new ProtocolError("invalid_argument", `Model ${id} is unavailable in Impact.`);
      const request = chatRequest(requestJson(await readBody(req)), model.id, model.max_output_tokens ?? model.max_tokens);
      return streamGeneration(connection, request, res, controller.signal);
    }
    const method = url.pathname.split("/").at(-1);
    const adjusted = ["GetUserStatus", "GetSlashCommands", "SendUserCascadeMessage", "SendAllQueuedMessages", "RevertToCascadeStep", "StartCascade", "StartBattleMode"];
    if (req.method === "POST" && url.pathname.startsWith("/exa.language_server_pb.LanguageServerService/") && adjusted.includes(method!)) {
      const contentType = String(req.headers["content-type"] ?? "application/json");
      if (!contentType.includes("json")) throw new ProtocolError("invalid_argument", "This Antigravity build requires an unsupported RPC encoding.");
      let body = rpcBody(await readBody(req), contentType);
      if (method === "StartCascade") { const input = object(body); body = { ...input, requestedModel: 326 }; }
      else if (method === "StartBattleMode") throw new ProtocolError("unimplemented", "Antigravity's model comparison mode is not supported through Impact yet. Start a single-model conversation.");
      else if (method !== "GetUserStatus") body = adaptMessage(body, current.models, current.selected);
      const upstream = await call(current.runtime, url.pathname, body, controller.signal);
      let reply = upstreamJson(await readBody(upstream));
      if (method === "GetUserStatus" && upstream.statusCode === 200) reply = { ...reply, userStatus: { ...reply.userStatus, cascadeModelConfigData: nativeCatalog(current.models, current.selected) } };
      if (upstream.statusCode !== 200) {
        return fail(req, res, upstream.statusCode ?? 502, reply.code ?? "internal", reply.message ?? "Antigravity RPC failed");
      }
      return rpcReply(res, contentType, reply);
    }
    // Stock assets and long-lived agent updates stream unchanged, with backpressure handled by http-proxy.
    scrubIncoming(req);
    req.headers["x-codeium-csrf-token"] = current.runtime.csrf;
    forward.web(req, res, { target: target(current.runtime) });
  };
  return {
    handle(req: IncomingMessage, res: ServerResponse) {
      void dispatch(req, res).catch(async error => {
        if (res.destroyed) return;
        const known = error instanceof ProtocolError;
        const message = known ? error.message : "Cannot complete the Antigravity request. Check impact proxy status.";
        const status = known && error.code === "unauthenticated" ? 401 : known && error.code === "invalid_argument" ? 400 : 502;
        if (res.headersSent) { await writeEvent(res, { error: { code: status, message, status: "INTERNAL" } }, new AbortController().signal).catch(() => {}); res.end(); }
        else fail(req, res, status, known ? error.code : "unavailable", message);
      });
    },
    upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
      void options.login().then(async connection => {
        if (!authentic(req, connection) || req.headers.origin && req.headers.origin !== options.origin) return socket.destroy();
        const current = await restore(connection);
        scrubIncoming(req);
        req.headers["x-codeium-csrf-token"] = current.runtime.csrf;
        forward.ws(req, socket, head, { target: target(current.runtime) });
      }).catch(() => socket.destroy());
    },
    async close() {
      closed = true; forward.close();
      await session?.runtime.close();
      await preparing?.catch(() => {});
    },
  };
}

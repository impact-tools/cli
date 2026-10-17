import type { IncomingMessage, ServerResponse } from "node:http";
import type { Http2ServerRequest } from "node:http2";
import { Http2ServerResponse } from "node:http2";

import { once } from "node:events";
import { gunzipSync } from "node:zlib";

import type { Connection } from "../../config/Connection.ts";
import { CursorAccount, readRefresh, type CursorModel } from "./Account.ts";
import { createAgentBridge } from "./Agent.ts";
import { impactRequest, ProtocolError, streamChat, type ChatMessage } from "./Impact.ts";
import { CursorWire, decodeFrames, endFrame, frame } from "./Wire.ts";

type Request = IncomingMessage | Http2ServerRequest;
type Response = ServerResponse | Http2ServerResponse;
const MAX_BODY = 4 * 1024 * 1024;
const publicRpc = new Set(["/aiserver.v1.ServerConfigService/GetServerConfig", "/aiserver.v1.AiService/ServerTime", "/aiserver.v1.AiService/HealthCheck", "/aiserver.v1.AnalyticsService/Batch", "/aiserver.v1.AnalyticsService/BootstrapStatsig"]);
const housekeeping = new Set([
  "/aiserver.v1.AnalyticsService/Batch", "/aiserver.v1.AnalyticsService/BootstrapStatsig",
  "/aiserver.v1.AnalyticsService/SubmitLogs", "/aiserver.v1.AnalyticsService/TrackEvents",
  "/aiserver.v1.AiService/CppEditHistoryStatus", "/aiserver.v1.AiService/KnowledgeBaseList",
  "/aiserver.v1.AiService/AvailableDocs", "/aiserver.v1.CppService/RecordCppFate",
  "/aiserver.v1.AiService/ReportAiCodeChangeMetrics", "/aiserver.v1.AiService/UpdateVscodeProfile",
  "/aiserver.v1.MCPRegistryService/GetKnownServers", "/aiserver.v1.DashboardService/ListMarketplacePlugins",
  "/aiserver.v1.DashboardService/GetTeams", "/aiserver.v1.DashboardService/GetUserOrganizations",
  "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam", "/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
  "/aiserver.v1.DashboardService/GetGlobalCommands", "/aiserver.v1.DashboardService/GetTeamCommands",
  "/aiserver.v1.DashboardService/GetManagedSkills", "/aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "/aiserver.v1.DashboardService/ListMarketplaces", "/aiserver.v1.DashboardService/RegisterMarketplaceAndPlugins",
  "/aiserver.v1.DashboardService/GetScmConnectionStatus", "/aiserver.v1.DashboardService/GetPlanInfo",
  "/aiserver.v1.DashboardService/IsOnNewPricing", "/aiserver.v1.AiService/GetDefaultModelNudgeData",
  "/aiserver.v1.AuthService/SetPrivacyMode", "/aiserver.v1.AuthService/GetPrivacyMode",
  "/agent.v1.AgentService/UpdateConversationMetadata", "/agent.v1.AgentService/GetAllowedModelIntents",
]);

export async function cursorBody(request: Request): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ProtocolError("resource_exhausted", "Cursor request exceeds 4 MiB.");
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body, { maxOutputLength: MAX_BODY });
  else if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new ProtocolError("invalid_argument", "Unsupported request compression.");
  return body;
}
const media = (request: Request) => request.headers["content-type"]?.split(";")[0]?.trim() ?? "application/proto";
const streaming = (request: Request) => media(request).startsWith("application/connect+");
const json = (request: Request) => media(request).endsWith("json");
const headers = (type: string) => ({ "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" });
const writeHead = (response: Response, status: number, value: Record<string, string>) => {
  if (response instanceof Http2ServerResponse) response.writeHead(status, value);
  else response.writeHead(status, value);
};
const sendJson = (response: Response, value: unknown, status = 200) => { writeHead(response, status, headers("application/json")); response.end(JSON.stringify(value)); };
async function write(response: Response, bytes: Buffer, signal: AbortSignal) {
  if (response.destroyed || signal.aborted) throw new ProtocolError("canceled", "Request canceled.");
  const accepted = response instanceof Http2ServerResponse ? response.write(bytes) : response.write(bytes);
  if (!accepted) await once(response, "drain", { signal });
}
/** Answers a Cursor request with a Connect error: an end frame for streams, JSON otherwise. */
export function failCursorRequest(request: Request, response: Response, error: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const failure = error instanceof ProtocolError ? error : new ProtocolError("invalid_argument", "Cannot process this Cursor request.");
  if (streaming(request)) {
    if (!response.headersSent) writeHead(response, 200, headers(media(request)));
    response.end(endFrame({ code: failure.code, message: failure.message }));
  } else if (!response.headersSent) sendJson(response, { code: failure.code, message: failure.message }, failure.code === "unauthenticated" ? 401 : failure.code === "unimplemented" ? 501 : failure.code === "resource_exhausted" ? 429 : failure.code === "unavailable" ? 503 : 400);
  else response.destroy();
}

/** `persistent` keeps the session after Cursor signs out; the background proxy serves later launches too. */
export function createCursorNative(connection: Connection, account: CursorAccount, models: readonly CursorModel[], wire: CursorWire, options: { readonly persistent?: boolean } = {}) {
  const modelIds = models.map((model) => model.id);
  const agent = createAgentBridge(wire, connection, modelIds);
  const active = new Set<AbortController>();
  const available = () => ({
    modelNames: modelIds,
    models: models.map((model) => {
      const capabilities = model.capabilities;
      const tools = Array.isArray(capabilities) ? capabilities.includes("tools") : (capabilities as { supports_tool_use?: boolean } | undefined)?.supports_tool_use ?? true;
      const vision = Array.isArray(capabilities) ? capabilities.includes("vision") : (capabilities as { supports_vision?: boolean } | undefined)?.supports_vision ?? false;
      // Cursor renders named picker sections only for models with a section index.
      return { namedModelSectionIndex: 1, name: model.id, serverModelName: model.id, clientDisplayName: model.display_name ?? model.id, defaultOn: true, supportsAgent: tools, supportsImages: vision, supportsThinking: (model.reasoning_efforts?.length ?? 0) > 0, supportsAutoContext: true, supportsNonMaxMode: true, supportsMaxMode: false, contextTokenLimit: model.context_length ?? 128_000, autoContextMaxTokens: model.context_length ?? 128_000, supportsPlanMode: false, supportsCmdK: true };
    }),
    ...Object.fromEntries(["composerModelConfig", "cmdKModelConfig", "planExecutionModelConfig", "specModelConfig"].map((name) => [name, { defaultModel: modelIds[0] }])),
  });
  const unary = (request: Request, response: Response, output: string, value: Record<string, unknown>) => {
    const encoded = wire.encode(output, value, json(request));
    writeHead(response, 200, headers(streaming(request) ? media(request) : json(request) ? "application/json" : "application/proto"));
    response.end(streaming(request) ? Buffer.concat([frame(encoded), endFrame()]) : encoded);
  };
  async function decoded(request: Request, input: string) {
    const body = await cursorBody(request);
    if (!streaming(request)) return wire.decode(input, body, json(request));
    let payload: Buffer | undefined;
    for await (const part of decodeFrames((async function* () { yield body; })(), MAX_BODY)) {
      if (part.flags & 2) continue;
      if (payload) throw new ProtocolError("invalid_argument", "Send one native request frame.");
      payload = part.payload;
    }
    if (!payload) throw new ProtocolError("invalid_argument", "Send one native request frame.");
    return wire.decode(input, payload, json(request));
  }
  async function handle(request: Request, response: Response, path: string, signal: AbortSignal, proxyAuthenticated: boolean) {
    if (request.method === "OPTIONS") { writeHead(response, 204, headers("application/json")); response.end(); return; }
    if (path === "/tev1/v1/rgstr" && request.method === "POST") { await cursorBody(request); sendJson(response, {}); return; }
    if (path === "/oauth/token" && request.method === "POST") {
      const input = readRefresh(JSON.parse((await cursorBody(request)).toString()));
      return sendJson(response, await account.refresh(input.refresh_token, signal));
    }
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!publicRpc.has(path) && !account.accepts(token) && !(proxyAuthenticated && !request.headers.authorization && account.accepts(account.token))) {
      if (process.env.IMPACT_CURSOR_DEBUG === "1" && (path.includes("AgentService") || path.includes("BidiAppend"))) process.stderr.write(`[Cursor] Auth rejected ${path}: ${JSON.stringify({ headers: Object.keys(request.headers), bearer: Boolean(token), bearerLength: token?.length, version: request.httpVersion })}\n`);
      throw new ProtocolError("unauthenticated", "Launch Cursor with impact cursor to connect your Impact account.");
    }
    if (path === "/auth/full_stripe_profile") return sendJson(response, { membershipType: "pro", subscriptionStatus: "active", email: `Impact · ${account.email}`, lastPaymentFailed: false });
    if (path === "/api/auth/me") return sendJson(response, { id: account.id, email: account.email });
    if (path === "/api/auth/logout" || path === "/auth/logout") { if (!options.persistent) { account.close(); agent.close(); } return sendJson(response, { success: true }); }
    if (path === "/auth/poll") throw new ProtocolError("failed_precondition", "Sign in with impact login, then relaunch with impact cursor.");
    if (path === "/aiserver.v1.AiService/StreamCpp") {
      if (request.method !== "POST" || media(request) !== "application/connect+proto") throw new ProtocolError("invalid_argument", "Use Connect protobuf for Cursor Tab.");
      const body = await cursorBody(request);
      const clientHeaders: Record<string, string> = {};
      for (const name of ["x-cursor-client-type", "x-cursor-client-version", "x-cursor-streaming", "x-session-id", "x-request-id"]) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length <= 1024) clientHeaders[name] = value;
      }
      if (!clientHeaders["x-cursor-client-version"] && wire.clientVersion)
        clientHeaders["x-cursor-client-version"] = wire.clientVersion;
      const upstream = await impactRequest(connection, path, body, signal, {
        ...clientHeaders,
        "content-type": media(request), "connect-protocol-version": "1",
        ...(typeof request.headers["connect-content-encoding"] === "string" ? { "connect-content-encoding": request.headers["connect-content-encoding"] } : {}),
        ...(typeof request.headers["connect-accept-encoding"] === "string" ? { "connect-accept-encoding": request.headers["connect-accept-encoding"] } : {}),
        "connect-timeout-ms": "30000",
      });
      const encoding = upstream.headers["connect-content-encoding"];
      writeHead(response, 200, { ...headers(upstream.headers["content-type"] ?? "application/connect+proto"), ...(typeof encoding === "string" ? { "connect-content-encoding": encoding } : {}) });
      let bytes = 0;
      try { for await (const chunk of upstream) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new ProtocolError("resource_exhausted", "Tab response exceeds 16 MiB."); await write(response, chunk, signal); } response.end(); }
      finally { upstream.destroy(); }
      return;
    }
    // Cursor's extension-host HTTP/1 proxy can omit its origin headers. The
    // authenticated CONNECT capability still binds it to this CLI launch.
    if (proxyAuthenticated && !request.headers["content-type"]) {
      if (/\/Run(?:SSE|Poll)?$/.test(path)) request.headers["content-type"] = "application/connect+proto";
      else if (path.endsWith("/BidiAppend")) request.headers["content-type"] = "application/proto";
    }
    if (agent.handle(request, response, path)) return;
    const method = wire.method(path);
    if (!method || request.method !== "POST") throw new ProtocolError("unimplemented", `Impact does not support Cursor route ${path}.`);
    const input = await decoded(request, method.input);
    let value: Record<string, unknown> | undefined;
    switch (path) {
      case "/aiserver.v1.AiService/AvailableModels": value = available(); break;
      case "/aiserver.v1.AiService/GetDefaultModel": value = { model: modelIds[0], thinkingModel: modelIds[0], maxMode: false }; break;
      case "/aiserver.v1.AiService/NameTab": value = { name: String(input.messages?.find((message: { type: number; text?: string }) => message.type === 1)?.text ?? "Impact chat").replace(/\s+/g, " ").slice(0, 80) }; break;
      case "/agent.v1.AgentService/GetUsableModels": value = { models: models.map((m) => ({ modelId: m.id, displayModelId: m.id, displayName: m.display_name ?? m.id, displayNameShort: m.display_name ?? m.id })) }; break;
      case "/agent.v1.AgentService/GetDefaultModelForCli": value = { model: { modelId: modelIds[0], displayModelId: modelIds[0], displayName: models[0]?.display_name ?? modelIds[0], displayNameShort: models[0]?.display_name ?? modelIds[0] } }; break;
      case "/aiserver.v1.ServerConfigService/GetServerConfig": value = { configVersion: "impact-local-1", http2Config: 1, chatConfig: { disableStatsig: true, fullContextTokenLimit: models[0]?.context_length ?? 128_000, maxMcpTools: 128, maxRuleLength: 100_000 }, metricsConfig: { enabledInPrivacyMode: false, enabledInNonPrivacyMode: false }, clientTracingConfig: { globalSampleRate: 0, tracesSampleRate: 0, loggerSampleRate: 0 }, agentUrlConfig: { agentUrl: "https://agent.api5.cursor.sh", agentnUrl: "https://agent.api5.cursor.sh" } }; break;
      case "/aiserver.v1.AnalyticsService/BootstrapStatsig": value = { config: JSON.stringify({ feature_gates: {}, dynamic_configs: {}, layer_configs: {}, has_updates: true, time: Date.now() }), generatedAtMs: BigInt(Date.now()) }; break;
      case "/aiserver.v1.AiService/CppConfig": value = { isOn: true, isGhostText: true, shouldLetUserEnableCppEvenIfNotPro: true, shouldFetchRvfText: true, allowsTabChunks: false, cppUrl: "https://api3.cursor.sh", geoCppBackendUrl: "https://api3.cursor.sh", aboveRadius: 40, belowRadius: 10, globalDebounceDurationMillis: 100, clientDebounceDurationMillis: 100, includeUnchangedLines: true }; break;
      case "/aiserver.v1.FileSyncService/FSIsEnabledForUser": value = { enabled: false }; break;
      case "/aiserver.v1.CppService/AvailableModels": value = { models: ["default"], defaultModel: "default" }; break;
      case "/aiserver.v1.DashboardService/GetUserPrivacyMode": value = { privacyMode: 1, partnerDataShare: false, hasAcknowledgedGracePeriodDisclaimer: true }; break;
      case "/aiserver.v1.DashboardService/GetCurrentPeriodUsage": value = { enabled: false, displayMessage: "Impact wallet · impact status" }; break;
      case "/aiserver.v1.AuthService/GetEmail": value = { email: `Impact · ${account.email}`, signUpType: 0 }; break;
      case "/aiserver.v1.DashboardService/GetMe": value = { authId: account.id, email: `Impact · ${account.email}`, firstName: "Impact" }; break;
      case "/aiserver.v1.AiService/GetUserInfo": value = { userId: account.id }; break;
      case "/aiserver.v1.AiService/ServerTime": value = { receiveTimestamp: Date.now() / 1000, transmitTimestamp: Date.now() / 1000 }; break;
      case "/aiserver.v1.AiService/HealthCheck": value = {}; break;
      default: if (housekeeping.has(path)) value = {};
    }
    if (value) { unary(request, response, method.output, value); return; }
    if (/\/(?:StreamChat|StreamChatWeb|StreamUnifiedChat|StreamComposer|StreamCmdK|StreamTerminalCmdK)$/.test(path) && method.kind === "server") {
      const selected = input.modelDetails?.modelName ?? modelIds[0];
      const model = selected === "default" ? modelIds[0]! : selected;
      if (!modelIds.includes(model)) throw new ProtocolError("invalid_argument", "Select an enabled Impact model.");
      if (input.isAgentic) throw new ProtocolError("unimplemented", "This chat protocol cannot execute agent tools. Use Cursor's native agent.");
      const messages: ChatMessage[] = [];
      if (input.explicitContext?.context) messages.push({ role: "system", content: input.explicitContext.context });
      if (input.currentFile?.contents) messages.push({ role: "system", content: `Current file: ${input.currentFile.relativeWorkspacePath ?? ""}\n${input.currentFile.contents}` });
      for (const message of input.conversation ?? []) {
        if (message.text) messages.push({ role: message.type === 2 ? "assistant" : "user", content: message.text });
      }
      if (!messages.some((message) => message.role === "user")) {
        const prompt = input.query ?? input.prompt ?? input.instruction ?? input.userMessage;
        if (typeof prompt !== "string" || !prompt) throw new ProtocolError("invalid_argument", "Cursor request contains no user message.");
        messages.push({ role: "user", content: prompt });
      }
      writeHead(response, 200, headers(json(request) ? "application/connect+json" : "application/connect+proto"));
      for await (const delta of streamChat(connection, { model, messages }, signal)) {
        if (delta.toolCalls?.length) throw new ProtocolError("unimplemented", "Tool calls require Cursor's agent protocol.");
        if (delta.content) await write(response, frame(wire.encode(method.output, { text: delta.content }, json(request))), signal);
        if (delta.reasoning && wire.type(method.output).fields.list().some((field) => field.localName === "thinking")) await write(response, frame(wire.encode(method.output, { thinking: { text: delta.reasoning } }, json(request))), signal);
      }
      response.end(endFrame());
      return;
    }
    throw new ProtocolError("unimplemented", `Impact does not support Cursor RPC ${path}.`);
  }
  return {
    handler(request: Request, response: Response, _host: string, context?: { proxyAuthenticated: boolean }) {
      const path = (request.url ?? "/").split("?")[0]!;
      if (process.env.IMPACT_CURSOR_DEBUG === "1") process.stderr.write(`[Cursor] ${request.method} ${path}\n`);
      const controller = new AbortController(); active.add(controller);
      const timer = setTimeout(() => { controller.abort(); failCursorRequest(request, response, new ProtocolError("deadline_exceeded", "Cursor request timed out.")); }, path.endsWith("/StreamCpp") ? 35_000 : 10 * 60_000); timer.unref();
      response.once("close", () => { clearTimeout(timer); active.delete(controller); controller.abort(); });
      request.once("aborted", () => controller.abort());
      void handle(request, response, path, controller.signal, context?.proxyAuthenticated ?? false).catch((error) => {
        if (process.env.IMPACT_CURSOR_DEBUG === "1") process.stderr.write(`[Cursor] Failed ${path}: ${error instanceof ProtocolError ? error.code : "invalid_argument"}\n`);
        failCursorRequest(request, response, error);
      });
    },
    close() { agent.close(); account.close(); for (const controller of active) controller.abort(); },
  };
}

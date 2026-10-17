import type { ClientRequest, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { Effect, Redacted } from "effect";
import httpProxy from "http-proxy";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { urlToHttpOptions } from "node:url";

import type { Connection } from "../../config/Connection.ts";

import { CLI_VERSION, VERSION_HEADER } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { isCodexRoute } from "./Routes.ts";
import { createProxyCertificate } from "./Tls.ts";

const FORWARDED =
  /^\/(?:v1\/(?:models|responses(?:\/compact)?)|backend-api\/codex\/(?:models|responses(?:\/compact)?)|api\/codex\/usage)(?:\?|$)/;

export type Route = { readonly reply: unknown } | { readonly forward: string } | undefined;

/** Under the secret `prefix`: a local reply, an upstream path, or nothing for every other request. */
export function route(url: string, prefix: string, replies: Readonly<Record<string, unknown>> = {}): Route {
  if (!url.startsWith(`${prefix}/`)) return undefined;
  const path = url.slice(prefix.length);
  if (Object.hasOwn(replies, path)) return { reply: replies[path] };
  return (FORWARDED.test(path) || isCodexRoute(path)) ? { forward: path } : undefined;
}

/** ChatGPT account endpoints Codex polls; Impact answers them with the key owner's identity. */
const accountReplies = (accountId: string, origin: string) => ({
  "/api/codex/accounts/check": {
    accounts: [
      {
        id: accountId,
        name: "Impact LLM",
        workspace_backend_origin: origin,
        account_routing_override: "NO_CONSTRAINT",
        structure: "personal",
      },
    ],
    account_ordering: [accountId],
    default_account_id: accountId,
  },
  "/api/codex/rate-limit-reset-credits": { credits: [], available_count: 0 },
});

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  if (!response.headersSent)
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const failed = () => new CliError({ message: "Cannot start the local Codex proxy." });

const listen = (server: Server, port: number) =>
  Effect.callback<number, CliError>((resume) => {
    server.once("error", () => resume(Effect.fail(failed())));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resume(address && typeof address !== "string" ? Effect.succeed(address.port) : Effect.fail(failed()));
    });
  });

export interface CodexUpstream {
  readonly connection: Connection;
  readonly accountId: string;
}

/** Why a request cannot reach Impact, with the HTTP status Codex receives. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CodexProxyOptions {
  /** The loopback server certificate; Codex trusts its CA through `CODEX_CA_CERTIFICATE`. */
  readonly tls: { readonly key: string; readonly cert: string };
  readonly port?: number;
  /** The secret path every route lives under; random by default. */
  readonly prefix?: string;
  /** Other clients may share this authenticated loopback TLS listener. */
  readonly fallback?: { handle(request: IncomingMessage, response: ServerResponse): void; upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void };
}

const failure = (error: unknown) =>
  error instanceof UpstreamError ? error : new UpstreamError(502, "Cannot reach Impact.");

/**
 * A loopback boundary keeps native OpenAI credentials away from Impact. `upstream` is resolved for every
 * request, so the proxy follows the current Impact login.
 */
const makeCodexProxy = Effect.fn("codexProxy")(function* (
  upstream: () => Promise<CodexUpstream>,
  options: CodexProxyOptions,
) {
  const prefix = options.prefix ?? `/${randomUUID()}`;
  const credentials = new WeakMap<object, Connection>();
  const proxy = httpProxy.createProxyServer({
    // The route allowlist supplies origin-relative paths; avoid the legacy URL parser.
    toProxy: true,
    changeOrigin: true,
    ws: true,
    proxyTimeout: 10 * 60_000,
  });
  const target = (connection: Connection) => {
    const url = new URL(connection.baseUrl);
    return { ...urlToHttpOptions(url), host: url.host, port: url.port };
  };
  const withImpactCredentials = (request: ClientRequest, incoming: object) => {
    const connection = credentials.get(incoming);
    if (connection) request.setHeader("authorization", `Bearer ${Redacted.value(connection.apiKey)}`);
    else request.removeHeader("authorization");
    request.setHeader(VERSION_HEADER, CLI_VERSION);
    for (const header of ["cookie", "chatgpt-account-id", "openai-organization", "x-api-key", "proxy-authorization"])
      request.removeHeader(header);
  };
  const prepareForward = (request: IncomingMessage, connection: Connection) => {
    for (const header of ["cookie", "chatgpt-account-id", "openai-organization", "x-api-key", "proxy-authorization"])
      delete request.headers[header];
    request.headers.authorization = `Bearer ${Redacted.value(connection.apiKey)}`;
    request.headers[VERSION_HEADER] = CLI_VERSION;
    // http-proxy skips proxyReq when Expect is present; credentials must already be safe.
    delete request.headers.expect;
  };
  proxy.on("proxyReq", (request, incoming) => withImpactCredentials(request, incoming));
  proxy.on("proxyReqWs", (request, incoming) => withImpactCredentials(request, incoming));
  proxy.on("error", (_error, _request, response) => {
    if ("writeHead" in response)
      sendJson(response as ServerResponse, 502, { error: { message: "Cannot reach Impact.", type: "upstream_error" } });
    else response.destroy();
  });

  const server = createServer({ key: options.tls.key, cert: options.tls.cert });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
      proxy.close();
    }),
  );
  const origin = `https://127.0.0.1:${yield* listen(server, options.port ?? 0)}`;

  server.on("request", (request, response) => {
    const url = request.url ?? "";
    // Unknown paths are refused before any login is read.
    if (route(url, prefix, accountReplies("", origin)) === undefined) {
      if (options.fallback && !url.startsWith(prefix + "/")) return options.fallback.handle(request, response);
      return response.writeHead(404).end();
    }
    request.pause();
    upstream().then(
      (session) => {
        const resolved = route(url, prefix, accountReplies(session.accountId, origin))!;
        if ("reply" in resolved) return sendJson(response, 200, resolved.reply);
        request.url = resolved.forward;
        prepareForward(request, session.connection);
        credentials.set(request, session.connection);
        proxy.web(request, response, { target: target(session.connection) });
      },
      (error) => {
        const { status, message } = failure(error);
        sendJson(response, status, { error: { message, type: status === 401 ? "authentication_error" : "upstream_error" } });
        request.resume();
      },
    );
  });
  server.on("upgrade", (request, socket, head) => {
    if (options.fallback && !(request.url ?? "").startsWith(prefix + "/")) return options.fallback.upgrade(request, socket as Socket, head);
    const resolved = route(request.url ?? "", prefix);
    if (!resolved || !("forward" in resolved) || !resolved.forward.split("?")[0]!.endsWith("/responses"))
      return socket.destroy();
    upstream().then(
      (session) => {
        request.url = resolved.forward;
        prepareForward(request, session.connection);
        credentials.set(request, session.connection);
        proxy.ws(request, socket, head, { target: target(session.connection) });
      },
      () => socket.destroy(),
    );
  });
  return { baseUrl: `${origin}${prefix}` };
});

/** New shared-daemon API plus the old per-launch form kept for existing CLI integrations. */
export function codexProxy(
  connection: Connection,
  accountId: string,
): Effect.Effect<{ readonly baseUrl: string; readonly certificateFile: string }, CliError, never>;
export function codexProxy(
  upstream: () => Promise<CodexUpstream>,
  options: CodexProxyOptions,
): Effect.Effect<{ readonly baseUrl: string }, CliError, never>;
export function codexProxy(
  first: Connection | (() => Promise<CodexUpstream>),
  second: string | CodexProxyOptions,
) {
  if (typeof first === "function") return makeCodexProxy(first, second as CodexProxyOptions);
  return Effect.flatMap(createProxyCertificate(), ({ key, cert, certificateFile }) =>
    makeCodexProxy(
      async () => ({ connection: first, accountId: second as string }),
      { tls: { key, cert } },
    ).pipe(Effect.map((proxy) => ({ ...proxy, certificateFile }))),
  );
}

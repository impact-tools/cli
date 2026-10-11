import type { ClientRequest, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { Effect, Redacted } from "effect";
import httpProxy from "http-proxy";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { urlToHttpOptions } from "node:url";

import type { Connection } from "../../config/Connection.ts";

import { CLI_VERSION, VERSION_HEADER } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { isCodexRoute, pathname } from "./Routes.ts";
import { createProxyCertificate } from "./Tls.ts";

export type Route = { readonly reply: unknown } | { readonly forward: string } | undefined;

/** Under the secret `prefix`: a local reply, an upstream path, or nothing for every other request. */
export function route(url: string, prefix: string, replies: Readonly<Record<string, unknown>> = {}): Route {
  if (!url.startsWith(`${prefix}/`)) return undefined;
  const path = url.slice(prefix.length);
  if (Object.hasOwn(replies, path)) return { reply: replies[path] };
  return isCodexRoute(path) ? { forward: path } : undefined;
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
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const failed = () => new CliError({ message: "Cannot start the local Codex proxy." });

const listen = (server: Server) =>
  Effect.callback<number, CliError>((resume) => {
    server.once("error", () => resume(Effect.fail(failed())));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(address && typeof address !== "string" ? Effect.succeed(address.port) : Effect.fail(failed()));
    });
  });

/** A loopback boundary keeps native OpenAI credentials away from Impact. */
export const codexProxy = Effect.fn("codexProxy")(function* (connection: Connection, accountId: string) {
  const { key, cert, certificateFile } = yield* createProxyCertificate();
  const prefix = `/${randomUUID()}`;
  const target = new URL(connection.baseUrl);
  const upstream = httpProxy.createProxyServer({
    target: { ...urlToHttpOptions(target), host: target.host, port: target.port },
    // The route allowlist supplies origin-relative paths; avoid the legacy URL parser.
    toProxy: true,
    changeOrigin: true,
    ws: true,
    proxyTimeout: 10 * 60_000,
  });
  const withImpactCredentials = (request: ClientRequest) => {
    request.setHeader("authorization", `Bearer ${Redacted.value(connection.apiKey)}`);
    request.setHeader(VERSION_HEADER, CLI_VERSION);
    for (const header of ["cookie", "chatgpt-account-id", "openai-organization", "x-api-key"])
      request.removeHeader(header);
  };
  upstream.on("proxyReq", withImpactCredentials);
  upstream.on("proxyReqWs", withImpactCredentials);
  upstream.on("error", (_error, _request, response) => {
    if ("writeHead" in response)
      sendJson(response as ServerResponse, 502, { error: { message: "Cannot reach Impact.", type: "upstream_error" } });
    else response.destroy();
  });

  const server = createServer({ key, cert });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
      upstream.close();
    }),
  );
  const baseUrl = `https://127.0.0.1:${yield* listen(server)}${prefix}`;

  const replies = accountReplies(accountId, new URL(baseUrl).origin);
  server.on("request", (request, response) => {
    const target = route(request.url ?? "", prefix, replies);
    if (target === undefined) response.writeHead(404).end();
    else if ("reply" in target) sendJson(response, 200, target.reply);
    else {
      request.url = target.forward;
      upstream.web(request, response);
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const target = route(request.url ?? "", prefix);
    if (!target || !("forward" in target) || !pathname(target.forward).endsWith("/responses")) return socket.destroy();
    request.url = target.forward;
    upstream.ws(request, socket, head);
  });
  return { baseUrl, certificateFile };
});

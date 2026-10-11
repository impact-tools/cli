import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Server, Socket } from "node:net";

import { Effect, Redacted } from "effect";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent as HttpAgent, createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as http2Server, Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, createServer as netServer } from "node:net";
import { gunzipSync } from "node:zlib";

import type { Connection } from "../../config/Connection.ts";

import { CLI_VERSION, VERSION_HEADER } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { configureTab } from "./TabConfig.ts";

const COMPLETION_PATH = "/aiserver.v1.AiService/StreamCpp";
const CONFIG_PATH = "/aiserver.v1.AiService/CppConfig";
const FILESYNC_ENABLED_PATH = "/aiserver.v1.FileSyncService/FSIsEnabledForUser";
const CURSOR_ORIGIN = "https://api2.cursor.sh";
const H2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const GATEWAY_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-cursor-team-id",
  "chatgpt-account-id",
  "openai-organization",
]);
const API_PATH =
  /^\/v1\/(?:models(?:\/[^/?]+)?|usage(?:\/spend)?|responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?|images\/(?:generations|edits))(?:\?|$)/;
const NATIVE_PATH = /^\/(?:aiserver|agent|origin)\.v1\.[A-Za-z]+Service\/[A-Za-z][A-Za-z0-9]*(?:\?|$)/;

type Request = IncomingMessage | Http2ServerRequest;
type Response = ServerResponse | Http2ServerResponse;

export interface ProxyOptions {
  readonly port?: number;
  readonly cursorOrigin?: string;
  /** Refuse loopback connections opened by another user, where the system can tell (Linux). */
  readonly sameUserOnly?: boolean;
}

/** Whether the proxy sends `path` (query included) to Impact's API with the key. */
export const isApiPath = (path: string) => API_PATH.test(path);

const hexPort = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");

/**
 * The user that opened a loopback connection, from the kernel's IPv4 socket table: the peer's
 * entry has the connection's remote port as its local one. Undefined where the table can't be
 * read or no longer lists the peer.
 */
export const loopbackPeerUid = async (socket: Socket): Promise<number | undefined> => {
  if (process.platform !== "linux" || !socket.remotePort || !socket.localPort) return undefined;
  const table = await readFile("/proc/net/tcp", "utf8").catch(() => "");
  const local = new RegExp(`^[0-9A-F]{6}7F:${hexPort(socket.remotePort)}$`);
  const remote = new RegExp(`^[0-9A-F]{6}7F:${hexPort(socket.localPort)}$`);
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (local.test(fields[1] ?? "") && remote.test(fields[2] ?? "")) return Number(fields[7]);
  }
  return undefined;
};

const cleanHeaders = (headers: IncomingHttpHeaders, gateway = false) => {
  const connection = headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? [];
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":") || HOP_HEADERS.has(name) || connection.includes(name)) continue;
    if (gateway && GATEWAY_HEADERS.has(name)) continue;
    result[name] = value;
  }
  return result;
};

const writeHead = (response: Response, status: number, headers: IncomingHttpHeaders) => {
  if (response instanceof Http2ServerResponse) response.writeHead(status, headers);
  else response.writeHead(status, headers);
};

const reply = (response: Response, status: number, message: string) => {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) return response.destroy();
  writeHead(response, status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(message);
};

const listen = (server: Server, port: number) =>
  Effect.callback<number, CliError>((resume) => {
    const failed = () => resume(Effect.fail(new CliError({ message: `Cannot listen on proxy port ${port}.` })));
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      const address = server.address();
      resume(
        address && typeof address !== "string"
          ? Effect.succeed(address.port)
          : Effect.fail(new CliError({ message: "Cannot start the proxy." })),
      );
    });
  });

/**
 * A capability URL exposes API routes and Cursor's native backend on loopback only. Cursor learns
 * the URL from its arguments, which other local users can list, so a launch also checks who opens
 * each connection (`sameUserOnly`). The public port relays each connection to an internal HTTP/1
 * or HTTP/2 server on loopback; their ports are just as visible, so they serve relayed connections
 * only.
 */
export const cursorProxy = Effect.fn("cursorProxy")(function* (connection: Connection, options: ProxyOptions = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    return yield* new CliError({ message: "Use a proxy port between 0 and 65535." });

  const prefix = `/${randomUUID()}`;
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  /** `<internal server port>:<relay port>` of each open relay from the public port. */
  const relays = new Set<string>();
  const httpAgent = new HttpAgent({ keepAlive: true });
  const httpsAgent = new HttpsAgent({ keepAlive: true });
  const handle = (request: Request, response: Response) => {
    if (!relays.has(`${request.socket.localPort}:${request.socket.remotePort}`))
      return void (request instanceof Http2ServerRequest ? request.stream.session : request.socket)?.destroy();
    const url = request.url ?? "";
    if (!url.startsWith(`${prefix}/`)) return reply(response, 404, "Route not found.");
    const path = url.slice(prefix.length);
    const pathname = path.split("?")[0];
    const completion = pathname === COMPLETION_PATH;
    const config = pathname === CONFIG_PATH;
    const gateway = completion || isApiPath(path);
    if (!gateway && !NATIVE_PATH.test(path)) return reply(response, 404, "Route not found.");
    if ((completion || config || pathname === FILESYNC_ENABLED_PATH) && request.method !== "POST")
      return reply(response, 405, "Use POST for Cursor Tab.");
    if (!gateway && request.headers.authorization?.includes("sk-imp-"))
      return reply(response, 403, "Cursor control requests require a Cursor login.");
    if (pathname === FILESYNC_ENABLED_PATH) {
      // A gateway account cannot resolve files synced under the editor's own account.
      const json = request.headers["content-type"]?.startsWith("application/json");
      writeHead(response, 200, {
        "content-type": json ? "application/json" : "application/proto",
        "cache-control": "no-store",
      });
      response.end(json ? '{"enabled":false}' : Buffer.alloc(0));
      request.resume();
      return;
    }
    if (completion && Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES)
      return reply(response, 413, "The Cursor request exceeds 4 MiB.");

    const target = new URL(gateway ? connection.baseUrl : (options.cursorOrigin ?? CURSOR_ORIGIN));
    const outgoingUrl = new URL(path, target);
    const headers = cleanHeaders(request.headers, gateway);
    if (gateway) {
      headers.authorization = `Bearer ${Redacted.value(connection.apiKey)}`;
      headers[VERSION_HEADER] = CLI_VERSION;
    }
    if (config) headers["accept-encoding"] = "identity";
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    let incoming: IncomingMessage | undefined;
    const outgoing = transport(
      outgoingUrl,
      {
        method: request.method,
        headers,
        agent: target.protocol === "https:" ? httpsAgent : httpAgent,
      },
      (upstream) => {
        incoming = upstream;
        if (response.destroyed) return upstream.destroy();
        if (config && upstream.statusCode === 200) {
          const chunks: Buffer[] = [];
          let bytes = 0;
          upstream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_CONFIG_BYTES) {
              reply(response, 502, "The Cursor Tab config is too large.");
              upstream.destroy();
            } else chunks.push(chunk);
          });
          upstream.once("end", () => {
            if (response.destroyed || response.writableEnded) return;
            try {
              let body = Buffer.concat(chunks);
              const encoding = upstream.headers["content-encoding"];
              if (encoding === "gzip") body = gunzipSync(body, { maxOutputLength: MAX_CONFIG_BYTES });
              else if (encoding && encoding !== "identity") throw new Error("Unsupported config compression.");
              const configured = configureTab(body, upstream.headers["content-type"] ?? "");
              const resultHeaders = cleanHeaders(upstream.headers);
              delete resultHeaders["content-length"];
              delete resultHeaders["content-encoding"];
              delete resultHeaders.etag;
              resultHeaders["cache-control"] = "no-store";
              writeHead(response, 200, resultHeaders);
              response.end(configured);
            } catch {
              reply(response, 502, "Cannot configure Cursor Tab from this backend response.");
            }
          });
          upstream.once("error", () => reply(response, 502, "Cannot read Cursor Tab config."));
          upstream.once("aborted", () => reply(response, 502, "Cannot read Cursor Tab config."));
          return;
        }
        writeHead(response, upstream.statusCode ?? 502, cleanHeaders(upstream.headers));
        upstream.once("error", () => response.destroy());
        upstream.once("aborted", () => response.destroy());
        upstream.pipe(response);
      },
    );
    requests.add(outgoing);
    const timer = setTimeout(
      () => {
        reply(response, 504, "The proxy request timed out.");
        outgoing.destroy();
        incoming?.destroy();
      },
      completion ? 35_000 : 10 * 60_000,
    );
    timer.unref();
    const cancel = () => {
      clearTimeout(timer);
      requests.delete(outgoing);
      outgoing.destroy();
      incoming?.destroy();
    };
    request.once("aborted", cancel);
    request.once("error", cancel);
    response.once("close", cancel);
    outgoing.once("error", () => reply(response, 502, gateway ? "Cannot reach Impact." : "Cannot reach Cursor."));
    if (completion) {
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          reply(response, 413, "The Cursor request exceeds 4 MiB.");
          request.unpipe(outgoing);
          outgoing.destroy();
          request.resume();
        }
      });
    }
    request.pipe(outgoing);
  };

  const http1 = httpServer(handle);
  const http2 = http2Server();
  http2.on("request", handle);
  http2.on("session", (session) => session.on("error", () => session.destroy()));
  let http1Port = 0;
  let http2Port = 0;
  const server = netServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    let head = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const length = Math.min(head.length, H2_PREFACE.length);
      const h2 = head.subarray(0, length).equals(H2_PREFACE.subarray(0, length));
      if (h2 && head.length < H2_PREFACE.length) return;
      socket.pause();
      socket.off("data", read);
      socket.setTimeout(0);
      const upstream = netConnect(h2 ? http2Port : http1Port, "127.0.0.1");
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
      upstream.once("connect", () => {
        const relay = `${upstream.remotePort}:${upstream.localPort}`;
        relays.add(relay);
        upstream.once("close", () => relays.delete(relay));
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
    };
    if (!options.sameUserOnly || process.getuid === undefined) return void socket.on("data", read);
    const uid = process.getuid();
    void loopbackPeerUid(socket).then((peer) => {
      if (peer !== undefined && peer !== uid) socket.destroy();
      else if (!socket.destroyed) socket.on("data", read);
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const outgoing of requests) outgoing.destroy();
      for (const socket of sockets) socket.destroy();
      httpAgent.destroy();
      httpsAgent.destroy();
      http1.close();
      http2.close();
      server.close();
    }),
  );
  for (const internal of [http1, http2])
    internal.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  http1Port = yield* listen(http1, 0);
  http2Port = yield* listen(http2, 0);
  const actualPort = yield* listen(server, port);
  server.on("error", () => server.close());
  return { baseUrl: `http://127.0.0.1:${actualPort}${prefix}` };
});

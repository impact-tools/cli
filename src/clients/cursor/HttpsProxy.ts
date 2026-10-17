import type { IncomingMessage, ServerResponse } from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import type { Socket } from "node:net";

import { Effect } from "effect";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { connect, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateValidity, issueCertificatePair } from "../../tls/Issue.ts";
import { CliError } from "../../Errors.ts";

export type NativeHandler = (
  request: IncomingMessage | Http2ServerRequest,
  response: ServerResponse | Http2ServerResponse,
  host: string,
  context?: { readonly proxyAuthenticated: boolean },
) => void;

/** Only enumerated Cursor origins terminate TLS; arbitrary subdomains do not. */
export const CURSOR_PROXY_HOSTS: ReadonlySet<string> = new Set([
  "cursor.sh", "www.cursor.sh", "api.cursor.sh", "auth.cursor.sh",
  "api2.cursor.sh", "api3.cursor.sh", "api4.cursor.sh", "api5.cursor.sh",
  "agent.api5.cursor.sh", "repo42.cursor.sh",
  "prod.authentication.cursor.sh", "authenticator.cursor.sh",
  "us-only.gcpp.cursor.sh", "global.gcpp.cursor.sh",
  "agentn.api5.cursor.sh", "agentn-us.api5.cursor.sh", "agentn-eu.api5.cursor.sh", "agentn-ap.api5.cursor.sh",
  "agent-gcpp-uswest.api5.cursor.sh", "agentn-gcpp-apsoutheast.api5.cursor.sh",
  "agentn-gcpp-eucentral.api5.cursor.sh", "agentn-gcpp-uswest.api5.cursor.sh",
  "cursor.com", "www.cursor.com", "api.cursor.com", "auth.cursor.com",
  "origin.cursor.com", "origin-staging.cursor.com",
  "cursorapi.com", "api.cursorapi.com", "api2.cursorapi.com",
]);

/** DNS names a Cursor interception certificate covers. */
export const CURSOR_CERTIFICATE_NAMES: readonly string[] = [
  ...new Set(["cursor.sh", "*.cursor.sh", "cursor.com", "*.cursor.com", "cursorapi.com", "*.cursorapi.com", ...CURSOR_PROXY_HOSTS]),
];

/** Public unicast only: block loopback, private, link-local, multicast and reserved destinations. */
export const publicProxyAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Global IPv6 unicast 2000::/3 only; reject transition/documentation ranges too.
  const lower = address.toLowerCase();
  const [first = "", second = ""] = lower.split(":");
  const firstWord = Number.parseInt(first, 16);
  const secondWord = second === "" ? 0 : Number.parseInt(second, 16);
  return isIP(lower) === 6 && /^[23][0-9a-f]{0,3}:/.test(lower) &&
    !(firstWord === 0x2001 && (secondWord < 0x200 || secondWord === 0xdb8)) &&
    firstWord !== 0x2002 && firstWord !== 0x3fff;
};

const destination = (authority: string | undefined) => {
  if (!authority || !/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]+$/.test(authority)) return;
  let parsed: URL;
  try { parsed = new URL(`https://${authority}`); }
  catch { return; }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(authority.slice(authority.lastIndexOf(":") + 1));
  if (!host || port !== 443) return;
  return { host, port };
};

const temporaryMaterial = Effect.fn("temporaryMaterial")(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "impact-cursor-tls-")),
      catch: () => new CliError({ message: "Cannot create the Cursor TLS directory." }),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  return yield* Effect.tryPromise({
    try: async () => {
      const { ca, leaf } = await issueCertificatePair(
        certificateValidity(7),
        {
          commonName: `Impact Cursor ${randomUUID()}`,
          extensions: [
            { name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 0 },
            { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
          ],
        },
        {
          commonName: "api2.cursor.sh",
          extensions: [
            { name: "basicConstraints", cA: false },
            { name: "keyUsage", digitalSignature: true },
            { name: "extKeyUsage", serverAuth: true },
            { name: "subjectAltName", altNames: CURSOR_CERTIFICATE_NAMES.map((value) => ({ type: 2 as const, value })) },
          ],
        },
      );
      const extra = process.env.NODE_EXTRA_CA_CERTS ? await readFile(process.env.NODE_EXTRA_CA_CERTS, "utf8") : "";
      const certificateFile = join(directory, "roots.pem");
      await writeFile(certificateFile, `${extra}\n${ca.cert}\n`, { mode: 0o600 });
      return { key: leaf.private, cert: leaf.cert, certificateFile, spki: certificateSpki(leaf.cert) };
    },
    catch: () => new CliError({ message: "Cannot create the Cursor TLS certificate and trusted root bundle." }),
  });
});

export interface ProxyTls {
  readonly key: string;
  readonly cert: string;
  readonly spki: string;
  /** Roots for Node transports: the issuing CA, given to Cursor as `NODE_EXTRA_CA_CERTS`. */
  readonly certificateFile: string;
}

export interface CursorHttpsProxyOptions {
  readonly port?: number;
  /** A persistent certificate; without it the proxy creates a temporary CA and root bundle. */
  readonly tls?: ProxyTls;
  readonly credentials?: { readonly username: string; readonly password: string };
  /** Serves an authenticated plain request to the proxy itself; returns false for unknown paths. */
  readonly control?: (request: IncomingMessage, response: ServerResponse) => boolean;
  /** Other native clients share the CONNECT listener, with their own hosts, CA and authentication. */
  readonly additional?: { readonly hosts: ReadonlySet<string>; readonly tls: ProxyTls; readonly handler: NativeHandler };
}

/** The base64 SHA-256 of a certificate's public key, as Chromium's SPKI allowlist expects. */
export const certificateSpki = (cert: string) =>
  createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

export const cursorHttpsProxy = Effect.fn("cursorHttpsProxy")(function* (
  handler: NativeHandler,
  options: CursorHttpsProxyOptions = {},
) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    return yield* new CliError({ message: "Use a proxy port between 0 and 65535." });
  const material: ProxyTls = options.tls ?? (yield* temporaryMaterial());
  const username = options.credentials?.username ?? randomBytes(18).toString("hex");
  const password = options.credentials?.password ?? randomBytes(32).toString("hex");
  const credential = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const authorized = (request: IncomingMessage) => {
    const candidate = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return candidate.length === credential.length && timingSafeEqual(candidate, credential);
  };
  let closed = false;
  const sockets = new Set<Socket>();
  const secureServers = new Set<ReturnType<typeof createSecureServer>>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const deny = (socket: Socket, status: number, message: string) => {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="Impact Cursor"\r\n' : ""}Content-Length: 0\r\n\r\n`);
  };
  const server = createServer((request, response) => {
    if (authorized(request) && options.control?.(request, response)) return;
    response.writeHead(authorized(request) ? 405 : 407, {
      "connection": "close", "proxy-authenticate": 'Basic realm="Impact Cursor"',
    });
    response.end();
    request.resume();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.on("connection", (socket) => {
    track(socket);
    socket.setTimeout(10_000, () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, connection, head) => {
    const socket = connection as Socket;
    const target = destination(request.url);
    const proxyAuthenticated = authorized(request);
    const additional = target && options.additional?.hosts.has(target.host) ? options.additional : undefined;
    // Chromium removes proxy URL userinfo. Its only anonymous destination is a
    // local intercepted Cursor service; the native dispatcher checks its launch
    // bearer capability. Anonymous sockets can never become external tunnels.
    if (!proxyAuthenticated && !(target && (CURSOR_PROXY_HOSTS.has(target.host) || additional) && request.headers["proxy-authorization"] === undefined))
      return deny(socket, 407, "Proxy Authentication Required");
    delete request.headers["proxy-authorization"];
    if (!target) return deny(socket, 403, "Forbidden");
    if (process.env.IMPACT_CURSOR_DEBUG === "1") process.stderr.write(`[Cursor] CONNECT ${JSON.stringify({ host: target.host, proxyAuthenticated })}\n`);
    if (CURSOR_PROXY_HOSTS.has(target.host) || additional) {
      const tls = additional?.tls ?? material;
      const secure = createSecureServer({
        key: tls.key, cert: tls.cert, allowHTTP1: true, handshakeTimeout: 10_000,
        ...{ requireHostHeader: false },
        settings: { maxConcurrentStreams: 100, maxHeaderListSize: 16 * 1024 },
      });
      secureServers.add(secure);
      secure.on("error", () => socket.destroy());
      secure.on("tlsClientError", () => socket.destroy());
      secure.on("secureConnection", (tlsSocket) => track(tlsSocket));
      secure.on("session", (session) => {
        session.on("error", () => session.destroy());
        session.setTimeout(10 * 60_000, () => session.destroy());
        socket.once("close", () => session.destroy());
      });
      secure.on("request", (req, res) => {
        delete req.headers["proxy-authorization"];
        const authority = req.headers[":authority"] ?? req.headers.host;
        // Cursor's custom Node SSE tunnel omits Host. CONNECT already fixes its
        // local origin; explicit Host and HTTP/2 :authority must still match it.
        const implicitHttp1Origin = authority === undefined && req.httpVersionMajor === 1;
        if (!implicitHttp1Origin && (typeof authority !== "string" || authority.toLowerCase() !== target.host && authority.toLowerCase() !== `${target.host}:443`)) {
          if (process.env.IMPACT_CURSOR_DEBUG === "1") {
            // Bound and escape values from the wire; never log credential headers.
            process.stderr.write(`[Cursor] Authority mismatch: ${JSON.stringify({
              connect: target.host,
              authority: typeof authority === "string" ? authority.slice(0, 256) : null,
              method: req.method,
              path: req.url?.split("?")[0]?.slice(0, 256),
            })}\n`);
          }
          res.writeHead(421);
          res.end();
          req.resume();
          return;
        }
        const deadline = setTimeout(() => res.destroy(), 10 * 60_000);
        deadline.unref();
        res.once("close", () => clearTimeout(deadline));
        try { (additional?.handler ?? handler)(req, res, target.host, { proxyAuthenticated }); }
        catch { if (!res.headersSent) res.writeHead(500); res.end(); }
      });
      socket.once("close", () => {
        secureServers.delete(secure);
        secure.close();
      });
      socket.setTimeout(10 * 60_000, () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      secure.emit("connection", socket);
      return;
    }
    // Resolve once, validate every answer, and connect to that IP to prevent DNS rebinding.
    void lookup(target.host, { all: true }).then((addresses) => {
      if (closed || socket.destroyed) return;
      if (!addresses.length || addresses.some(({ address }) => !publicProxyAddress(address))) return deny(socket, 403, "Forbidden");
      const address = addresses[0]!;
      const upstream = connect({ host: address.address, family: address.family, port: target.port });
      track(upstream);
      const timeout = setTimeout(() => { upstream.destroy(); deny(socket, 504, "Gateway Timeout"); }, 10_000);
      timeout.unref();
      upstream.once("error", () => { clearTimeout(timeout); deny(socket, 502, "Bad Gateway"); });
      upstream.once("connect", () => {
        clearTimeout(timeout);
        if (closed || socket.destroyed) return upstream.destroy();
        socket.setTimeout(10 * 60_000, () => socket.destroy());
        upstream.setTimeout(10 * 60_000, () => upstream.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      socket.once("close", () => { clearTimeout(timeout); upstream.destroy(); });
      upstream.once("close", () => socket.destroy());
    }).catch(() => deny(socket, 502, "Bad Gateway"));
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    for (const secure of secureServers) secure.close();
    server.close();
  }));
  const actualPort = yield* Effect.tryPromise({
    try: () => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("No proxy address"));
        else resolve(address.port);
      });
    }),
    catch: () => new CliError({ message: "Cannot listen on the Cursor HTTPS proxy port." }),
  });
  return {
    proxyUrl: `http://${username}:${password}@127.0.0.1:${actualPort}`,
    port: actualPort,
    certificateFile: material.certificateFile,
    spki: material.spki,
  };
});

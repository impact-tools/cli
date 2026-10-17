import type { Socket } from "node:net";

import { Effect } from "effect";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { connect as h2Connect, Http2ServerResponse } from "node:http2";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";

import { cursorHttpsProxy, publicProxyAddress } from "../src/clients/cursor/HttpsProxy.ts";
import { ideCertificate, IDE_PROXY_HOSTS } from "../src/clients/antigravity/Tls.ts";

const openConnect = async (proxyUrl: string, authority: string, authenticated = true) => {
  const proxy = new URL(proxyUrl);
  const socket = netConnect(Number(proxy.port), proxy.hostname);
  await once(socket, "connect");
  const authorization = authenticated
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`
    : "";
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);
  const reply = await new Promise<string>((resolve, reject) => {
    let text = "";
    const data = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\r\n\r\n")) {
        socket.off("data", data);
        resolve(text);
      }
    };
    socket.on("data", data);
    socket.once("error", reject);
  });
  return { socket, reply };
};

const requestH1 = async (socket: Socket, ca: Buffer, host = "api2.cursor.sh") => {
  const secure = tlsConnect({ socket, ca, servername: "api2.cursor.sh", ALPNProtocols: ["http/1.1"] });
  await once(secure, "secureConnect");
  expect(secure.authorized).toBe(true);
  const result = new Promise<string>((resolve, reject) => {
    let body = "";
    secure.on("data", (chunk) => body += chunk.toString());
    secure.once("end", () => resolve(body));
    secure.once("error", reject);
  });
  secure.write(`GET /test HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: secret-to-strip\r\nConnection: close\r\n\r\n`);
  return result;
};

it("authenticates CONNECT and serves trusted TLS HTTP/1 and HTTP/2 locally", async () => {
  const seen: Array<{ host: string; auth: unknown; version: string }> = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const proxy = yield* cursorHttpsProxy((request, response, host, context) => {
      expect(context?.proxyAuthenticated).toBe(true);
      seen.push({ host, auth: request.headers["proxy-authorization"], version: request.httpVersion });
      if (response instanceof Http2ServerResponse) response.writeHead(200, { "content-type": "text/plain" });
      else response.writeHead(200, { "content-type": "text/plain" });
      response.end("local native response");
    });
    yield* Effect.promise(async () => {
      const ca = await readFile(proxy.certificateFile);
      const h1 = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
      expect(h1.reply).toContain("200 Connection Established");
      expect(await requestH1(h1.socket, ca)).toContain("local native response");
      const h2 = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
      const secure = tlsConnect({ socket: h2.socket, ca, servername: "api2.cursor.sh", ALPNProtocols: ["h2"] });
      await once(secure, "secureConnect");
      expect(secure.authorized).toBe(true);
      expect(secure.alpnProtocol).toBe("h2");
      const client = h2Connect("https://api2.cursor.sh", { createConnection: () => secure });
      const request = client.request({ ":path": "/test", "proxy-authorization": "secret-to-strip" });
      let response = "";
      request.on("data", (chunk) => response += chunk.toString());
      request.end();
      await once(request, "end");
      expect(response).toBe("local native response");
      client.destroy();
      expect(proxy.spki).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    });
  })));
  expect(seen).toEqual([
    { host: "api2.cursor.sh", auth: undefined, version: "1.1" },
    { host: "api2.cursor.sh", auth: undefined, version: "2.0" },
  ]);
});

it("rejects unauthenticated external tunnels, wrong capability, private destinations, non-HTTPS ports and mismatched authority", async () => {
  let called = false;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const proxy = yield* cursorHttpsProxy((_req, res) => { called = true; res.end(); });
    yield* Effect.promise(async () => {
      for (const [url, target, status, auth] of [
        [proxy.proxyUrl, "example.com:443", 407, false],
        [proxy.proxyUrl.replace(new URL(proxy.proxyUrl).password, "wrong"), "api2.cursor.sh:443", 407, true],
        [proxy.proxyUrl, "127.0.0.1:443", 403, true],
        [proxy.proxyUrl, "localhost:443", 403, true],
        [proxy.proxyUrl, "[::1]:443", 403, true],
        [proxy.proxyUrl, "api2.cursor.sh:80", 403, true],
        [proxy.proxyUrl, "user@api2.cursor.sh:443", 403, true],
        [proxy.proxyUrl, "[::::]:443", 403, true],
      ] as const) {
        const connection = await openConnect(url, target, auth);
        expect(connection.reply).toContain(`HTTP/1.1 ${status}`);
        connection.socket.destroy();
      }
      const connection = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
      const response = await requestH1(connection.socket, await readFile(proxy.certificateFile), "evil.example");
      expect(response).toContain("421");
    });
  })));
  expect(called).toBe(false);
});

it("accepts Chromium anonymous CONNECT only into fixed local Cursor services", async () => {
  const seen: string[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const proxy = yield* cursorHttpsProxy((request, response, host, context) => {
      expect(context?.proxyAuthenticated).toBe(false);
      seen.push(host);
      response.statusCode = request.headers.authorization === "Bearer local-launch-capability" ? 200 : 401;
      response.end("native capability required");
    });
    yield* Effect.promise(async () => {
      const ca = await readFile(proxy.certificateFile);
      const anonymous = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443", false);
      expect(anonymous.reply).toContain("200 Connection Established");
      expect(await requestH1(anonymous.socket, ca)).toContain("401");
      for (const authority of ["example.com:443", "evil.cursor.sh:443", "127.0.0.1:443", "api2.cursor.sh:80"]) {
        const rejected = await openConnect(proxy.proxyUrl, authority, false);
        expect(rejected.reply).toContain("407");
        rejected.socket.destroy();
      }
    });
  })));
  expect(seen).toEqual(["api2.cursor.sh"]);
});

it("accepts Cursor HTTP/1 SSE without Host using its trusted CONNECT origin", async () => {
  const seen: string[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const proxy = yield* cursorHttpsProxy((request, response, host) => {
      seen.push(`${host}${request.url}`);
      response.end("native SSE");
    });
    yield* Effect.promise(async () => {
      const tunnel = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
      const secure = tlsConnect({ socket: tunnel.socket, ca: await readFile(proxy.certificateFile), servername: "api2.cursor.sh", ALPNProtocols: ["http/1.1"] });
      await once(secure, "secureConnect");
      let result = "";
      secure.on("data", (chunk) => result += chunk.toString());
      const ended = once(secure, "end");
      secure.write("POST /agent.v1.AgentService/RunSSE HTTP/1.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      await ended;
      expect(result).toContain("200");
      expect(result).toContain("native SSE");
    });
  })));
  expect(seen).toEqual(["api2.cursor.sh/agent.v1.AgentService/RunSSE"]);
});

it("preserves inherited extra CA roots and removes certificate/listeners/active TLS sockets with scope", async () => {
  let certificateFile = "";
  let port = 0;
  let active: Socket | undefined;
  const roots = process.env.NODE_EXTRA_CA_CERTS;
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const parent = yield* cursorHttpsProxy((_req, res) => res.end());
      vi.stubEnv("NODE_EXTRA_CA_CERTS", parent.certificateFile);
      const child = yield* cursorHttpsProxy((_req, res) => res.end());
      certificateFile = child.certificateFile;
      port = Number(new URL(child.proxyUrl).port);
      yield* Effect.promise(async () => {
        expect(await readFile(child.certificateFile, "utf8")).toContain(await readFile(parent.certificateFile, "utf8"));
        const connection = await openConnect(child.proxyUrl, "api2.cursor.sh:443");
        active = tlsConnect({ socket: connection.socket, ca: await readFile(child.certificateFile), servername: "api2.cursor.sh" });
        active.on("error", () => {});
        await once(active, "secureConnect");
      });
    })));
    await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
    if (active && !active.destroyed) await once(active, "close");
    const rejected = netConnect(port, "127.0.0.1");
    const [error] = await once(rejected, "error");
    expect(error.code).toBe("ECONNREFUSED");
  } finally {
    active?.destroy();
    if (roots === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = roots;
  }
});

it("only allows public unicast IPs for passthrough", () => {
  for (const ip of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001::1", "2001:0000::1", "3fff::1", "2002:7f00:1::1"])
    expect(publicProxyAddress(ip), ip).toBe(false);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    expect(publicProxyAddress(ip), ip).toBe(true);
});

it("shares CONNECT with IDE using separate trusted certificates and bound authorities", async () => {
  const material = await ideCertificate(1);
  const seen: string[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const proxy = yield* cursorHttpsProxy((_req, res) => res.end("cursor"), {
      additional: { hosts: IDE_PROXY_HOSTS, tls: { ...material, spki: "", certificateFile: "" }, handler: (req, res, host, context) => {
        expect(context?.proxyAuthenticated).toBe(false);
        seen.push(host); res.statusCode = req.headers.authorization === "Bearer local-ide" ? 200 : 401; res.end("ide");
      } },
    });
    yield* Effect.promise(async () => {
      const cursor = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
      expect(await requestH1(cursor.socket, await readFile(proxy.certificateFile))).toContain("cursor");
      for (const [authority, token, status] of [["cloudcode-pa.googleapis.com", "local-ide", 200], ["cloudcode-pa.googleapis.com", "wrong", 401], ["api2.cursor.sh", "local-ide", 421]] as const) {
        const connection = await openConnect(proxy.proxyUrl, "cloudcode-pa.googleapis.com:443", false);
        const socket = tlsConnect({ socket: connection.socket, ca: material.ca, servername: "cloudcode-pa.googleapis.com", ALPNProtocols: ["http/1.1"] });
        await once(socket, "secureConnect"); expect(socket.authorized).toBe(true);
        let result = ""; socket.on("data", chunk => result += chunk.toString()); const ended = once(socket, "end");
        socket.write(`GET /test HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
        await ended; expect(result).toContain(`HTTP/1.1 ${status}`);
      }
      const unknown = await openConnect(proxy.proxyUrl, "unknown.googleapis.com:443", false);
      expect(unknown.reply).toContain("407"); unknown.socket.destroy();
    });
  })));
  expect(seen).toEqual(["cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
});

it("preserves HTTP/1 origin headers and gzip body in the Bun runtime CONNECT server", async () => {
  const child = spawn("bun", [fileURLToPath(new URL("./fixtures/cursor-bun-proxy.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => stderr += chunk.toString());
  try {
    const proxy = await new Promise<{ proxyUrl: string; certificateFile: string }>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Bun probe exited ${code}: ${stderr}`)));
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!));
      });
    });
    const connection = await openConnect(proxy.proxyUrl, "api2.cursor.sh:443");
    const socket = tlsConnect({ socket: connection.socket, ca: await readFile(proxy.certificateFile), servername: "api2.cursor.sh", ALPNProtocols: ["http/1.1"] });
    await once(socket, "secureConnect");
    let response = "";
    socket.on("data", (chunk) => response += chunk.toString());
    const ended = once(socket, "end");
    const frame = Buffer.concat([Buffer.from([0, 0, 1, 0, 0]), Buffer.alloc(64 * 1024, 65)]);
    const body = gzipSync(frame);
    socket.write(Buffer.concat([
      Buffer.from(`POST /agent.v1.AgentService/RunSSE HTTP/1.1\r\nHost: api2.cursor.sh\r\nAuthorization: Bearer local-native-secret\r\nContent-Type: application/connect+proto\r\nContent-Encoding: gzip\r\nConnect-Protocol-Version: 1\r\nProxy-Authorization: Basic never-expose\r\nX-Large-Header: ${"x".repeat(7000)}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`),
      Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from("\r\n0\r\n\r\n"),
    ]));
    await ended;
    expect(response).toContain("200 OK");
    const parsed = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
    expect(parsed.headers).toMatchObject({ host: "api2.cursor.sh", authorization: "Bearer local-native-secret", "content-type": "application/connect+proto", "content-encoding": "gzip", "connect-protocol-version": "1" });
    expect(parsed.headers["proxy-authorization"]).toBeUndefined();
    expect(parsed.body).toBe(frame.toString("base64"));
    expect(parsed.context.proxyAuthenticated).toBe(true);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  }
}, 10_000);

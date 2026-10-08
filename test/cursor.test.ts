import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:http2";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

import { cursorProxy } from "../src/clients/cursor/Proxy.ts";

const path = "/aiserver.v1.AiService/StreamCpp";
const requestBytes = Buffer.from([0, 0, 0, 0, 3, 0x80, 0x06, 0x07]);
const firstFrame = Buffer.from([0, 0, 0, 0, 3, 0x0a, 1, 0x41]);
const terminal = Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]);
const key = "sk-imp-test";
const connection = (baseUrl: string) => ({ baseUrl, apiKey: Redacted.make(key) });
const start = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

it.each(["http1", "http2"] as const)(
  "relays opaque Connect frames once over %s with streaming and isolated credentials",
  async (protocol) => {
    const received: { url?: string; headers: Record<string, unknown>; body: Buffer }[] = [];
    const sendTerminal = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { "content-type": "application/connect+proto", "connect-content-encoding": "identity" });
        res.write(firstFrame);
        void sendTerminal.promise.then(() => res.end(terminal));
      });
    });
    const endpoint = await start(server);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* cursorProxy(connection(endpoint));
          yield* Effect.promise(async () => {
            const headers = {
              authorization: "Bearer native-cursor-secret",
              cookie: "cursor-cookie",
              "x-api-key": "native-cursor-api-key",
              "x-cursor-team-id": "native-team",
              "content-type": "application/connect+proto",
              "connect-protocol-version": "1",
              "connect-timeout-ms": "30000",
              "connect-content-encoding": "identity",
              "x-cursor-client-version": "3.22.12",
            };
            const chunks: Buffer[] = [];
            if (protocol === "http1") {
              const response = await fetch(proxy.baseUrl + path, { method: "POST", headers, body: requestBytes });
              expect(response.status).toBe(200);
              expect(response.headers.get("content-type")).toBe("application/connect+proto");
              const reader = response.body!.getReader();
              chunks.push(Buffer.from((await reader.read()).value!));
              expect(Buffer.concat(chunks)).toEqual(firstFrame);
              sendTerminal.resolve();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(Buffer.from(value));
              }
            } else {
              const url = new URL(proxy.baseUrl);
              const session = connect(url.origin);
              session.on("error", () => {});
              try {
                const stream = session.request({ ":method": "POST", ":path": url.pathname + path, ...headers });
                stream.end(requestBytes);
                const [response] = await once(stream, "response");
                expect(response[":status"]).toBe(200);
                expect(response["content-type"]).toBe("application/connect+proto");
                for await (const chunk of stream) {
                  chunks.push(chunk);
                  if (Buffer.concat(chunks).equals(firstFrame)) sendTerminal.resolve();
                }
              } finally {
                session.destroy();
              }
            }
            expect(Buffer.concat(chunks)).toEqual(Buffer.concat([firstFrame, terminal]));
            expect(received).toHaveLength(1);
            expect(received[0]).toEqual({
              url: path,
              body: requestBytes,
              headers: expect.objectContaining({
                authorization: "Bearer sk-imp-test",
                "content-type": "application/connect+proto",
                "connect-protocol-version": "1",
                "connect-timeout-ms": "30000",
                "connect-content-encoding": "identity",
                "x-cursor-client-version": "3.22.12",
              }),
            });
            for (const name of ["cookie", "x-api-key", "x-cursor-team-id"])
              expect(received[0]!.headers[name]).toBeUndefined();
          });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      sendTerminal.resolve();
      await close(server);
    }
  },
);

it("sends Cursor control requests to Cursor with the original login and exposes API routes through Impact", async () => {
  const native: string[] = [];
  const impact: string[] = [];
  const cursor = createServer((req, res) => {
    native.push(req.url!, req.headers.authorization!, req.headers.cookie!);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"aboveRadius":12,"isOn":false,"shouldLetUserEnableCppEvenIfNotPro":false,"allowsTabChunks":true}');
  });
  const gateway = createServer((req, res) => {
    impact.push(req.url!, req.headers.authorization!);
    res.end("impact-models");
  });
  const cursorOrigin = await start(cursor);
  const endpoint = await start(gateway);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* cursorProxy(connection(endpoint), { cursorOrigin });
        yield* Effect.promise(async () => {
          const config = await fetch(`${proxy.baseUrl}/aiserver.v1.AiService/CppConfig`, {
            method: "POST",
            headers: { authorization: "Bearer cursor-secret", cookie: "cursor-session" },
          });
          expect(native).toEqual(["/aiserver.v1.AiService/CppConfig", "Bearer cursor-secret", "cursor-session"]);
          expect(await config.json()).toEqual({
            aboveRadius: 12,
            isOn: true,
            shouldLetUserEnableCppEvenIfNotPro: true,
            shouldFetchRvfText: true,
            allowsTabChunks: false,
          });
          const models = await fetch(`${proxy.baseUrl}/v1/models?flavor=cursor`);
          expect(await models.text()).toBe("impact-models");
          expect(impact).toEqual(["/v1/models?flavor=cursor", "Bearer sk-imp-test"]);
          const wrongOrigin = new URL(proxy.baseUrl).origin;
          for (const denied of [wrongOrigin + path, proxy.baseUrl + "/v1/modelsx", proxy.baseUrl + "/unknown"])
            expect((await fetch(denied)).status).toBe(404);
          expect((await fetch(proxy.baseUrl + path)).status).toBe(405);
          expect(
            (
              await fetch(`${proxy.baseUrl}/aiserver.v1.AiService/CppConfig`, {
                method: "POST",
                headers: { authorization: "Bearer sk-imp-test" },
              })
            ).status,
          ).toBe(403);
          expect(native).toHaveLength(3);
          expect(impact).toHaveLength(2);
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await close(cursor);
    await close(gateway);
  }
});

it("preserves protobuf config fields while enabling full-text Tab and disabling account-bound file sync", async () => {
  // Native config: radius=12, Tab off, non-Pro gating, context chunks on, and unknown field 100=7.
  const nativeConfig = Buffer.from([8, 12, 0x28, 0, 0x38, 0, 0xc8, 1, 1, 0xa0, 6, 7]);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    const compressed = gzipSync(nativeConfig);
    res.writeHead(200, {
      "content-type": "application/proto",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    res.end(compressed);
  });
  const endpoint = await start(server);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* cursorProxy(connection(endpoint), { cursorOrigin: endpoint });
        yield* Effect.promise(async () => {
          const config = await fetch(`${proxy.baseUrl}/aiserver.v1.AiService/CppConfig`, { method: "POST" });
          expect(config.status).toBe(200);
          expect(config.headers.get("content-type")).toBe("application/proto");
          expect(config.headers.get("content-encoding")).toBeNull();
          expect(Buffer.from(await config.arrayBuffer())).toEqual(
            Buffer.from([8, 12, 0x28, 0, 0x38, 0, 0xc8, 1, 1, 0xa0, 6, 7, 0x28, 1, 0x38, 1, 0xb0, 1, 1, 0xc8, 1, 0]),
          );
          const fsPath = `${proxy.baseUrl}/aiserver.v1.FileSyncService/FSIsEnabledForUser`;
          const enabled = await fetch(fsPath, { method: "POST", headers: { "content-type": "application/proto" } });
          expect(enabled.status).toBe(200);
          expect(enabled.headers.get("content-type")).toBe("application/proto");
          expect((await enabled.arrayBuffer()).byteLength).toBe(0);
          const json = await fetch(fsPath, { method: "POST", headers: { "content-type": "application/json" } });
          expect(await json.json()).toEqual({ enabled: false });
          expect(requests).toBe(1);
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await close(server);
  }
});

it("cancels the upstream stream when the editor aborts a completion", async () => {
  const cancelled = Promise.withResolvers<void>();
  const server = createServer((_req, res) => {
    res.once("close", () => cancelled.resolve());
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.write(firstFrame);
  });
  const endpoint = await start(server);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* cursorProxy(connection(endpoint));
        yield* Effect.promise(async () => {
          const controller = new AbortController();
          const response = await fetch(proxy.baseUrl + path, {
            method: "POST",
            body: requestBytes,
            signal: controller.signal,
          });
          const reader = response.body!.getReader();
          expect(Buffer.from((await reader.read()).value!)).toEqual(firstFrame);
          controller.abort();
          await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
          await cancelled.promise;
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await close(server);
  }
});

it("rejects a declared Tab body larger than 4 MiB without contacting the gateway", async () => {
  let dispatched = 0;
  const server = createServer((_req, res) => {
    dispatched++;
    res.end();
  });
  const endpoint = await start(server);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* cursorProxy(connection(endpoint));
        yield* Effect.promise(async () => {
          const status = await new Promise<number>((resolve, reject) => {
            const req = httpRequest(
              proxy.baseUrl + path,
              {
                method: "POST",
                headers: { "content-length": "4194305" },
              },
              (res) => {
                res.resume();
                res.once("end", () => resolve(res.statusCode!));
              },
            );
            req.once("error", reject);
            req.end(Buffer.alloc(4194305));
          });
          expect(status).toBe(413);
          expect(dispatched).toBe(0);
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    await close(server);
  }
});

it("releases the listening port on scope exit and reports occupied or invalid ports", async () => {
  const blocker = createServer();
  const endpoint = await start(blocker);
  const port = Number(new URL(endpoint).port);
  let proxyPort = 0;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const occupied = yield* Effect.flip(cursorProxy(connection(endpoint), { port }).pipe(Effect.scoped));
        expect(occupied.message).toBe(`Cannot listen on proxy port ${port}.`);
        const invalid = yield* Effect.flip(cursorProxy(connection(endpoint), { port: -1 }).pipe(Effect.scoped));
        expect(invalid.message).toBe("Use a proxy port between 0 and 65535.");
        const local = yield* cursorProxy(connection(endpoint)).pipe(Effect.scoped);
        proxyPort = Number(new URL(local.baseUrl).port);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const reused = createServer();
    reused.listen(proxyPort, "127.0.0.1");
    await once(reused, "listening");
    await close(reused);
  } finally {
    await close(blocker);
  }
});

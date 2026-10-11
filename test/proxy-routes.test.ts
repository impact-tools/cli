import type { AddressInfo } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connect as http2Connect } from "node:http2";
import { request } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";

import { CLI_VERSION, VERSION_HEADER } from "../src/api/Http.ts";
import { codexProxy, route } from "../src/clients/codex/Proxy.ts";
import { CLOSED_CODEX_ROUTES, CODEX_ROUTES } from "../src/clients/codex/Routes.ts";
import { cursorProxy, isApiPath } from "../src/clients/cursor/Proxy.ts";

const server = join(import.meta.dirname, "../../packages/server/src/v1");
const gateway = join(import.meta.dirname, "../../packages/gateway/src/providers/chatgpt/Native.ts");
const ROUTE_FILES = ["Routes.ts", "ReadRoutes.ts", "NativeRoutes.ts"];
/** The namespaces Impact's API and Codex's native protocols live under. */
const API_PATH = /^\/(?:v1|backend-api\/codex|api\/codex)\//;

const literals = (source: string, name: string) => {
  const list = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
  assert.isDefined(list, `cannot find the ${name} list`);
  return [...list!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
};

/**
 * Every API path the server registers, read from its route modules: plain strings, and templates
 * over the `${prefix}` and `${endpoint}` lists the modules iterate.
 */
const serverRoutes = () => {
  const context = literals(readFileSync(gateway, "utf8"), "CODEX_CONTEXT_ENDPOINTS");
  const routes = new Set<string>();
  for (const file of ROUTE_FILES) {
    const source = readFileSync(join(server, file), "utf8");
    for (const [, path] of source.matchAll(/"(\/[^"\s]*)"/g))
      if (API_PATH.test(path!) && !path!.endsWith("/")) routes.add(path!);
    const prefixes = [...source.matchAll(/\(\[([^\]]*)\] as const\)\.flatMap\(\(prefix\)/g)].flatMap((match) =>
      [...match[1]!.matchAll(/"([^"]+)"/g)].map((prefix) => prefix[1]!),
    );
    for (const [, template] of source.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
      const names = [...template!.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]!);
      if (!template!.startsWith("/") && !template!.startsWith("${prefix}")) continue;
      const values = (name: string) => {
        if (name === "prefix") return prefixes;
        if (name === "endpoint") return context;
        throw new Error(`${file}: teach this test the values of \${${name}} in ${template}`);
      };
      let expanded = [template!];
      for (const name of new Set(names))
        expanded = expanded.flatMap((path) => values(name).map((value) => path.replaceAll(`\${${name}}`, value)));
      for (const path of expanded) if (API_PATH.test(path)) routes.add(path);
    }
  }
  return [...routes].sort();
};

const closedBy = (closed: Readonly<Record<string, string>>, path: string) =>
  Object.keys(closed).find((entry) => (entry.endsWith("/*") ? path.startsWith(entry.slice(0, -1)) : entry === path));
const sample = (path: string) => path.replace(/:\w+/g, "gpt-6.1-sol");

/** Paths the Cursor proxy and `impact proxy` keep away from Impact's API. */
const CLOSED_API_ROUTES: Readonly<Record<string, string>> = {
  "/v1/keys/self/revoke": "a client must never revoke the key it runs on",
  "/v1/alpha/*": "server-side context management is off on Impact",
};

describe.skipIf(!existsSync(server))("proxy routes against the server", () => {
  const routes = serverRoutes();

  it("reads the server's routes", () => {
    for (const path of ["/v1/responses", "/v1/images/edits", "/backend-api/codex/images/generations"])
      assert.include(routes, path);
    assert.isTrue(routes.some((path) => path.startsWith("/v1/alpha/")));
  });

  it.each(routes)("Codex forwards %s or closes it on purpose", (path) => {
    const forwarded = route(`/nonce${sample(path)}`, "/nonce") !== undefined;
    const closed = closedBy(CLOSED_CODEX_ROUTES, path);
    assert.isTrue(forwarded !== (closed !== undefined), `${path}: forward it or add it to CLOSED_CODEX_ROUTES`);
  });

  it("forwards and closes only routes the server has", () => {
    for (const path of CODEX_ROUTES) assert.include(routes, path, `${path} is forwarded but not served`);
    for (const entry of Object.keys(CLOSED_CODEX_ROUTES))
      assert.isTrue(
        routes.some((path) => closedBy({ [entry]: "" }, path)),
        `${entry} is closed but not served`,
      );
  });

  it.each(routes.filter((path) => path.startsWith("/v1/")))("the Cursor proxy forwards %s or closes it", (path) => {
    const closed = closedBy(CLOSED_API_ROUTES, path);
    assert.isTrue(isApiPath(sample(path)) !== (closed !== undefined), `${path}: add it to API_PATH or close it`);
  });
});

describe("Cursor proxy API paths", () => {
  it("forwards token counting and single-model reads, never self-revocation", () => {
    for (const path of ["/v1/messages/count_tokens", "/v1/models/claude-sonnet-5-5", "/v1/models/gpt-6.1-sol?x=1"])
      assert.isTrue(isApiPath(path), path);
    for (const path of ["/v1/keys/self/revoke", "/v1/models/a/b", "/v1/messages/batches"])
      assert.isFalse(isApiPath(path), path);
  });
});

const upstream = async () => {
  const seen: IncomingHttpHeaders[] = [];
  const listener = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    seen,
    baseUrl: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`,
    close: () => {
      listener.closeAllConnections();
      listener.close();
    },
  };
};

const connection = (baseUrl: string) => ({ baseUrl, apiKey: Redacted.make("Impact-test-key") });

/** The TCP ports this process listens on: its socket descriptors in the kernel's IPv4 table. */
const listeningPorts = async () => {
  const inodes = new Set<string>();
  for (const fd of await readdir("/proc/self/fd")) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode) inodes.add(inode);
  }
  const ports = new Set<number>();
  for (const line of (await readFile("/proc/net/tcp", "utf8")).split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] === "0A" && inodes.has(fields[9] ?? ""))
      ports.add(Number.parseInt(fields[1]?.split(":")[1] ?? "", 16));
  }
  return ports;
};

/** The proxy's ports besides its public one: the internal servers it relays connections to. */
const internalPorts = Effect.fn(function* <E, R>(create: Effect.Effect<{ readonly baseUrl: string }, E, R>) {
  const before = yield* Effect.promise(listeningPorts);
  const proxy = yield* create;
  const after = yield* Effect.promise(listeningPorts);
  const ports = [...after].filter((port) => !before.has(port) && port !== Number(new URL(proxy.baseUrl).port));
  return { proxy, ports };
});

/** The status a direct HTTP/2 request gets, or `refused` when the server drops it. */
const http2Status = (origin: string, path: string) =>
  new Promise<number | "refused">((resolve) => {
    const session = http2Connect(origin);
    const done = (status: number | "refused") => {
      session.destroy();
      resolve(status);
    };
    session.on("error", () => done("refused"));
    session.on("close", () => done("refused"));
    const stream = session.request({ ":path": path });
    stream.on("response", (headers) => done(Number(headers[":status"])));
    stream.on("error", () => done("refused"));
    stream.on("close", () => done("refused"));
    stream.end();
  });

const http1Status = (url: string) =>
  fetch(url).then(
    (response) => response.status,
    () => "refused" as const,
  );

describe("proxied requests", () => {
  it.live("the Codex proxy names the CLI release beside the client's own user-agent", () =>
    Effect.gen(function* () {
      const impact = yield* Effect.promise(upstream);
      yield* Effect.addFinalizer(() => Effect.sync(impact.close));
      const proxy = yield* codexProxy(connection(impact.baseUrl), "account");
      const ca = yield* Effect.promise(() => readFile(proxy.certificateFile));
      const status = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            const req = request(
              `${proxy.baseUrl}/v1/images/generations`,
              { method: "POST", ca, headers: { "user-agent": "codex-tui/0.160.0" } },
              (res) => {
                res.resume();
                resolve(res.statusCode!);
              },
            );
            req.on("error", reject);
            req.end("{}");
          }),
      );
      expect(status).toBe(200);
      expect(impact.seen).toHaveLength(1);
      expect(impact.seen[0]![VERSION_HEADER]).toBe(CLI_VERSION);
      expect(impact.seen[0]!["user-agent"]).toBe("codex-tui/0.160.0");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("the Cursor proxy names the CLI release on API calls", () =>
    Effect.gen(function* () {
      const impact = yield* Effect.promise(upstream);
      yield* Effect.addFinalizer(() => Effect.sync(impact.close));
      const proxy = yield* cursorProxy(connection(impact.baseUrl));
      const response = yield* Effect.promise(() =>
        fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, { method: "POST", body: "{}" }),
      );
      expect(response.status).toBe(200);
      expect(impact.seen[0]![VERSION_HEADER]).toBe(CLI_VERSION);
      expect(impact.seen[0]!.authorization).toBe("Bearer Impact-test-key");
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(process.platform !== "linux")("the Cursor proxy's internal servers refuse direct connections", () =>
    Effect.gen(function* () {
      const impact = yield* Effect.promise(upstream);
      yield* Effect.addFinalizer(() => Effect.sync(impact.close));
      const { proxy, ports } = yield* internalPorts(cursorProxy(connection(impact.baseUrl)));
      expect(ports).toHaveLength(2);
      const path = `${new URL(proxy.baseUrl).pathname}/v1/models`;
      for (const port of ports) {
        const origin = `http://127.0.0.1:${port}`;
        expect(yield* Effect.promise(() => http1Status(origin + path)), `HTTP/1.1 to ${port}`).toBe("refused");
        expect(yield* Effect.promise(() => http2Status(origin, path)), `HTTP/2 to ${port}`).toBe("refused");
      }
      expect(impact.seen).toHaveLength(0);
      expect((yield* Effect.promise(() => fetch(`${proxy.baseUrl}/v1/models`))).status).toBe(200);
      expect(yield* Effect.promise(() => http2Status(new URL(proxy.baseUrl).origin, path))).toBe(200);
      expect(impact.seen).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  // Root can open a connection as another user; curl is a client that user can run.
  const curl = "/usr/bin/curl";
  const asNobody = process.platform === "linux" && process.getuid?.() === 0 && existsSync(curl);
  const curlAsNobody = (url: string, protocol: "--http1.1" | "--http2-prior-knowledge" = "--http1.1") =>
    Effect.promise(() =>
      promisify(execFile)(curl, ["-s", protocol, "-o", "/dev/null", "-w", "%{http_code}", url], {
        uid: 65_534,
        gid: 65_534,
        cwd: "/",
        timeout: 15_000,
      }).then(
        ({ stdout }) => stdout,
        (error: { stdout: string }) => error.stdout,
      ),
    );
  it.live.skipIf(!asNobody)("a Cursor launch refuses connections another local user opens", () =>
    Effect.gen(function* () {
      const impact = yield* Effect.promise(upstream);
      yield* Effect.addFinalizer(() => Effect.sync(impact.close));
      const { proxy, ports } = yield* internalPorts(cursorProxy(connection(impact.baseUrl), { sameUserOnly: true }));
      const url = `${proxy.baseUrl}/v1/models`;
      expect((yield* Effect.promise(() => fetch(url))).status).toBe(200);
      expect(yield* curlAsNobody(url)).toBe("000");
      expect(yield* curlAsNobody(url, "--http2-prior-knowledge")).toBe("000");
      expect(ports).toHaveLength(2);
      const path = `${new URL(proxy.baseUrl).pathname}/v1/models`;
      for (const port of ports)
        for (const protocol of ["--http1.1", "--http2-prior-knowledge"] as const)
          expect(yield* curlAsNobody(`http://127.0.0.1:${port}${path}`, protocol), `${protocol} to ${port}`).toBe(
            "000",
          );
      expect(impact.seen).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

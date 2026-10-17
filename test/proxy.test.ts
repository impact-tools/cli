import type { AddressInfo } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

import { codexProxy } from "../src/clients/codex/Proxy.ts";
import { codexCaBundle, loopbackCertificate } from "../src/clients/codex/Tls.ts";

it("forwards through the bundled Codex proxy on Node when deprecated API calls are fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "impact-proxy-node-test-"));
  const entry = join(directory, "proxy.mjs");
  const run = promisify(execFile);
  try {
    await run("bun", [
      "build",
      fileURLToPath(new URL("./fixtures/proxy-deprecation.ts", import.meta.url)),
      "--target=node",
      `--outfile=${entry}`,
    ]);
    const result = await run(process.execPath, ["--throw-deprecation", entry]);
    expect(JSON.parse(result.stdout)).toEqual({ status: 200, body: "proxied" });
    expect(result.stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("trusts a nested launch certificate and substitutes Impact credentials before forwarding", async () => {
  const seen: { url?: string; authorization?: string; cookie?: string; account?: string }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      account: req.headers["chatgpt-account-id"] as string | undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"models":[]}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let certificateFile: string | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parent = yield* codexCaBundle((yield* Effect.promise(() => loopbackCertificate(1))).ca);
        vi.stubEnv("CODEX_CA_CERTIFICATE", parent);
        const material = yield* Effect.promise(() => loopbackCertificate(1));
        certificateFile = yield* codexCaBundle(material.ca);
        let logins = 0;
        const proxy = yield* codexProxy(
          async () => {
            logins += 1;
            return {
              connection: {
                baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
                apiKey: Redacted.make("Impact-test-key"),
              },
              accountId: "native-account",
            };
          },
          { tls: material },
        );
        expect(new URL(proxy.baseUrl).protocol).toBe("https:");
        const ca = yield* Effect.promise(() => readFile(certificateFile!));
        const get = (path: string) =>
          Effect.promise(
            () =>
              new Promise<{ status: number; body: string }>((resolve, reject) => {
                const req = request(
                  proxy.baseUrl + path,
                  {
                    ca,
                    headers: {
                      authorization: "Bearer native-OpenAI-secret",
                      cookie: "OpenAI-cookie",
                      "chatgpt-account-id": "OpenAI-account",
                      "x-api-key": "OpenAI-api-key",
                    },
                  },
                  (res) => {
                    let body = "";
                    res.on("data", (chunk) => {
                      body += chunk.toString();
                    });
                    res.on("end", () => resolve({ status: res.statusCode!, body }));
                  },
                );
                req.on("error", reject);
                req.end();
              }),
          );
        expect((yield* get("/v1/models")).status).toBe(200);
        expect(seen).toEqual([
          { url: "/v1/models", authorization: "Bearer Impact-test-key", cookie: undefined, account: undefined },
        ]);
        const expectRequest = Effect.promise(
          () =>
            new Promise<{ status: number; body: string }>((resolve, reject) => {
              const req = request(proxy.baseUrl + "/v1/responses", {
                method: "POST",
                ca,
                headers: {
                  authorization: "Bearer native-OpenAI-secret",
                  cookie: "OpenAI-cookie",
                  "chatgpt-account-id": "OpenAI-account",
                  "content-length": "2",
                  expect: "100-continue",
                },
              }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk.toString(); });
                res.on("end", () => resolve({ status: res.statusCode!, body }));
              });
              req.once("continue", () => req.end("{}"));
              req.once("error", reject);
              req.flushHeaders();
            }),
        );
        expect((yield* expectRequest).status).toBe(200);
        expect(seen.at(-1)).toEqual({
          url: "/v1/responses", authorization: "Bearer Impact-test-key", cookie: undefined, account: undefined,
        });
        const check = JSON.parse((yield* get("/api/codex/accounts/check")).body);
        expect(check.accounts[0].workspace_backend_origin).toBe(new URL(proxy.baseUrl).origin);
        expect((yield* get("/api/mcp")).status).toBe(404);
        expect(seen).toHaveLength(2);
        // Each routed request reads the current login; refused paths never do.
        expect(logins).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    await expect(stat(certificateFile!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

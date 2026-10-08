import { NodeServices } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";

import { codexProxy } from "../../src/clients/codex/Proxy.ts";

const upstream = createServer((_req, res) => res.end("proxied"));
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const proxy = yield* codexProxy(
        {
          baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
          apiKey: Redacted.make("test-key"),
        },
        "test-account",
      );
      yield* Effect.promise(async () => {
        const ca = await readFile(proxy.certificateFile);
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(proxy.baseUrl + "/v1/models", { ca }, (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk.toString();
            });
            res.once("end", () => resolve({ status: res.statusCode!, body }));
          });
          req.once("error", reject);
          req.end();
        });
        console.log(JSON.stringify(result));
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
} finally {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
}

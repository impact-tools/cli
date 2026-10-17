import { Effect } from "effect";
import { gunzipSync } from "node:zlib";
import { cursorHttpsProxy } from "../../src/clients/cursor/HttpsProxy.ts";

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const proxy = yield* cursorHttpsProxy(async (request, response, _host, context) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    response.end(JSON.stringify({
      headers: request.headers,
      body: request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes).toString("base64") : bytes.toString("base64"),
      context,
    }));
  });
  process.stdout.write(JSON.stringify(proxy) + "\n");
  yield* Effect.never;
})));

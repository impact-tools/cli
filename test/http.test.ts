import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { countModels } from "../src/api/Models.ts";
import { fetchUsage, usageSummary, walletBalance } from "../src/api/Usage.ts";
import { codexModels } from "../src/clients/codex/Models.ts";
import { connection, impactHttp, key, usage } from "./support/Impact.ts";

describe("Impact API", () => {
  it.each([
    [{ balance: "12.345", reserved: "2.5", total: "14.845" }, "14.845"],
    [{ balance: "12.345", reserved: "2.5" }, "12.345"],
    [{ balance: "0", reserved: "10", total: "3" }, "3"],
    [{ balance: "7", reserved: "10", total: "0" }, "0"],
  ] as const)("uses the authoritative wallet total with a legacy fallback: %j", (credits, expected) => {
    const wallet = { ...usage, currency: "USD" as const, credits };
    assert.strictEqual(walletBalance(wallet), expected);
    assert.strictEqual(usageSummary(connection, wallet), `Impact · ada@example.com · $${expected} USD`);
  });

  it.effect("sends the key as a bearer token and decodes the response", () =>
    Effect.gen(function* () {
      let authorization: string | undefined;
      const result = yield* fetchUsage(connection).pipe(
        Effect.provide(
          impactHttp((url, request) => {
            authorization = request.headers.authorization;
            return Response.json(url.pathname === "/v1/usage" ? usage : {});
          }),
        ),
      );
      assert.strictEqual(authorization, `Bearer ${key}`);
      assert.strictEqual(usageSummary(connection, result), "Impact · ada@example.com · $14.845 USD");
    }),
  );

  it.effect("passes the client version to the Codex catalog", () =>
    Effect.gen(function* () {
      let requested = "";
      const catalog = yield* codexModels(connection, "0.160.0").pipe(
        Effect.provide(
          impactHttp((url) => {
            requested = url.search;
            return Response.json({ models: [{ slug: "gpt-6.1-sol", base_instructions: "" }] });
          }),
        ),
      );
      assert.strictEqual(requested, "?client_version=0.160.0");
      assert.strictEqual(catalog.models[0]?.slug, "gpt-6.1-sol");
    }),
  );

  it.effect.each([
    [401, "Impact rejected this API key."],
    [403, "Impact rejected this API key."],
    [503, "Impact returned HTTP 503. Try again later."],
  ] as const)("reports HTTP %d", ([status, message]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        countModels(connection).pipe(Effect.provide(impactHttp(() => new Response(null, { status })))),
      );
      assert.strictEqual(error.message, message);
    }),
  );

  it.effect("reports a body that does not match the schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        countModels(connection).pipe(Effect.provide(impactHttp(() => new Response("<html>")))),
      );
      assert.strictEqual(error.message, "This endpoint did not return an Impact model catalog. Check the base URL.");
    }),
  );

  it.effect("removes control characters from the status line", () =>
    Effect.sync(() => {
      const line = usageSummary(connection, { ...usage, currency: "USD", account: { id: "x", email: "a\x1b[31m@b" } });
      assert.strictEqual(line, "Impact · a [31m@b · $14.845 USD");
      assert.notInclude(line, key);
    }),
  );
});

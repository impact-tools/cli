import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { stripVTControlCharacters } from "node:util";
import { vi } from "vitest";

import type { Capabilities } from "../src/ui/Theme.ts";

import { fetchSpend } from "../src/api/Spend.ts";
import { width } from "../src/ui/Layout.ts";
import { makeOutput } from "../src/ui/Output.ts";
import { renderSpend } from "../src/ui/Spend.ts";
import { connection, impactHttp, key, spend } from "./support/Impact.ts";

const tty: Capabilities = { decorative: true, color: 24, unicode: true, width: 80 };
const plain: Capabilities = { decorative: false, color: 0, unicode: false, width: 80 };

describe("spending API", () => {
  it.effect("reads the narrow endpoint with bearer authentication", () =>
    Effect.gen(function* () {
      let path = "";
      let authorization: string | undefined;
      const result = yield* fetchSpend(connection).pipe(
        Effect.provide(
          impactHttp((url, request) => {
            path = url.pathname;
            authorization = request.headers.authorization;
            return Response.json(spend);
          }),
        ),
      );
      assert.strictEqual(path, "/v1/usage/spend");
      assert.strictEqual(authorization, `Bearer ${key}`);
      assert.strictEqual(result.totalMicros, 3_125_000);
      assert.strictEqual(result.models[0]?.id, "claude-sonnet-5-5");
    }),
  );

  it.effect.each([
    {},
    { ...spend, currency: "EUR" },
    { ...spend, totalMicros: 0.5 },
    { ...spend, models: [{ id: "x", name: "X", chargedMicros: "100" }] },
    { ...spend, models: [{ id: "x", name: "X", chargedMicros: 0.5 }] },
    { ...spend, startAt: "yesterday" },
  ])("rejects malformed spending data: %j", (body) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fetchSpend(connection).pipe(Effect.provide(impactHttp(() => Response.json(body)))),
      );
      assert.strictEqual(error.message, "Impact returned invalid spending data.");
    }),
  );

  it.live("bounds a stalled request with the shared HTTP timeout", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fetchSpend(connection, "5 millis").pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.never))),
        ),
      );
      assert.include(error.message, "Cannot reach Impact");
    }),
  );
});

describe("spending presentation", () => {
  it("keeps redirected output plain and directly labels the total and model values", () => {
    assert.strictEqual(
      renderSpend(plain, spend),
      "Spend - last 7 days\nTotal: $3.13 USD\nSonnet 5.5: $2.00 USD\nGPT 6.1: $1.13 USD",
    );
    assert.notInclude(renderSpend(plain, spend), "\x1b");
  });

  it("distinguishes empty, unknown-only and unavailable data", () => {
    assert.include(renderSpend(plain, { ...spend, totalMicros: 0, models: [] }), "No spending in this period.");
    const unknown = renderSpend(plain, { ...spend, models: [] });
    assert.include(unknown, "Total: $3.13 USD");
    assert.include(unknown, "Model breakdown unavailable.");
    assert.notInclude(unknown, "No spending");
    const unavailable = renderSpend(plain, undefined);
    assert.include(unavailable, "Spending data unavailable");
    assert.notInclude(unavailable, "$0.00");
  });

  it("keeps each model, bar and amount on one aligned row", () => {
    const text = stripVTControlCharacters(renderSpend(tty, spend));
    const lines = text.split("\n");
    assert.strictEqual(lines.length, spend.models.length + 2);
    const rows = lines.slice(2);
    for (const [index, model] of spend.models.entries()) {
      assert.include(rows[index]!, model.name);
      assert.include(rows[index]!, "█");
      assert.include(rows[index]!, `$${(model.chargedMicros / 1_000_000).toFixed(2)} USD`);
    }
    assert.strictEqual(rows[0]!.indexOf("█"), rows[1]!.indexOf("█"));
    assert.strictEqual(width(rows[0]!), width(rows[1]!));
  });

  it("uses one zero scale without minimum bars for zero or sub-cell amounts", () => {
    const data = {
      ...spend,
      totalMicros: 1_501_000,
      models: [
        { id: "a", name: "Full", chargedMicros: 1_000_000 },
        { id: "b", name: "Half", chargedMicros: 500_000 },
        { id: "c", name: "Tiny", chargedMicros: 1_000 },
        { id: "d", name: "Zero", chargedMicros: 0 },
      ],
    };
    for (const unicode of [true, false]) {
      const text = stripVTControlCharacters(renderSpend({ ...tty, unicode }, data));
      const lines = text.split("\n");
      const marks = ["Full", "Half", "Tiny", "Zero"].map((name) =>
        lines.find((line) => line.startsWith(`  ${name} `))!,
      );
      const block = unicode ? "█" : "#";
      assert.strictEqual(marks[0]!.split(block).length - 1, 32);
      assert.strictEqual(marks[1]!.split(block).length - 1, 16);
      assert.notMatch(marks[2]!, /[█▏▎▍▌▋▊▉#]/);
      assert.notMatch(marks[3]!, /[█▏▎▍▌▋▊▉#]/);
      assert.include(marks[2]!, "$0.00 USD");
      assert.include(marks[3]!, "$0.00 USD");
    }
  });

  it("renders Other as an independent row and keeps server totals authoritative", () => {
    const text = renderSpend(plain, {
      ...spend,
      totalMicros: 9_000_000,
      models: [...spend.models, { id: "other", name: "Other models", chargedMicros: 1_000_000 }],
    });
    assert.include(text, "Total: $9.00 USD");
    assert.include(text, "Other models: $1.00 USD");
  });

  it("fits narrow terminals, including long and wide model names", () => {
    const data = { ...spend, models: [{ id: "long", name: "界".repeat(60), chargedMicros: 1 }] };
    for (const columns of [24, 38, 80, 100]) {
      const text = stripVTControlCharacters(renderSpend({ ...tty, width: columns }, data));
      assert.isTrue(text.split("\n").every((line) => width(line) <= columns));
      assert.include(text, "$0.00 USD");
      const modelRows = text.split("\n").filter((line) => line.includes("界"));
      assert.strictEqual(modelRows.length, 1);
      assert.include(modelRows[0]!, "…");
      assert.include(modelRows[0]!, "$0.00 USD");
    }
  });

  it("honors no-color and ASCII without introducing a new palette", () => {
    const monochrome = renderSpend({ ...tty, color: 0 }, spend);
    assert.notInclude(monochrome, "\x1b");
    assert.include(monochrome, "█");
    const ascii = renderSpend({ ...tty, color: 0, unicode: false }, spend);
    assert.match(ascii, /^[\x20-\x7e\n]*$/);
    assert.include(ascii, "#");
  });

  it("escapes malicious model labels before generating terminal styles", () => {
    const malicious = {
      ...spend,
      models: [{ id: "bad", name: "bad\x1b[2J\r\x07\u009b31m‮\nTotal: $0", chargedMicros: 1 }],
    };
    for (const caps of [plain, { ...tty, color: 0 as const }]) {
      const text = renderSpend(caps, malicious);
      assert.notMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f‮]/);
      assert.include(text, "\\u001b[2J");
      if (!caps.decorative) assert.include(text, "\\nTotal");
      assert.include(text, "Total");
    }
  });

  it("passes typed spending through Output without escaping its generated styles", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(makeOutput(tty, plain).spend(spend));
      assert.strictEqual(log.mock.calls.length, 1);
      const output = log.mock.calls[0]?.[0];
      assert.match(stripVTControlCharacters(output), /Total\s+\$3\.13 USD/);
      assert.include(output, "Sonnet 5.5");
      assert.include(output, "\x1b");
      assert.notInclude(output, "\\u001b");
    } finally {
      log.mockRestore();
    }
  });
});

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { openCodeModels } from "../src/clients/opencode/Models.ts";
import { prepareKilo, prepareOpenCode } from "../src/clients/opencode/Prepare.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { catalog, connection, impactHttp, key } from "./support/Impact.ts";

isolatedEnvironment();

describe.each([
  { client: "OpenCode", prepareClient: prepareOpenCode, variable: "OPENCODE_CONFIG_CONTENT" },
  { client: "Kilo", prepareClient: prepareKilo, variable: "KILO_CONFIG_CONTENT" },
] as const)("$client configuration", ({ prepareClient, variable }) => {
  const prepare = (args: readonly string[] = []) => prepareClient({ executable: "client", args, connection });
  const settingsOf = (env: NodeJS.ProcessEnv) => JSON.parse(env[variable]!);

  it.effect("selects an explicit Impact model and keeps all client flags", () =>
    Effect.gen(function* () {
      process.env.IMPACT_MODEL = "claude-sonnet-5-5";
      const args = ["run", "--model", "impact/gpt-6.1-sol", "--format", "json", "hello"];
      const prepared = yield* prepare(args);
      assert.deepStrictEqual(prepared.args, args);
      const settings = settingsOf(prepared.env);
      assert.strictEqual(settings.model, "impact/claude-sonnet-5-5");
      assert.strictEqual(settings.small_model, "impact/claude-sonnet-5-5");
      assert.strictEqual(prepared.env.IMPACT_API_KEY, key);
      assert.notInclude(prepared.env[variable]!, key);
    }).pipe(Effect.provide(impactHttp())),
  );

  it.effect("restricts inherited provider lists and preserves inline MCP and permissions", () =>
    Effect.gen(function* () {
      process.env[variable] = JSON.stringify({
        enabled_providers: ["openai", "anthropic"],
        disabled_providers: ["impact"],
        provider: { other: { npm: "custom-package" }, impact: { models: { stale: { name: "Stale" } } } },
        permission: { bash: "ask" },
        mcp: { example: { type: "local", command: ["server"] } },
      });
      const settings = settingsOf((yield* prepare()).env);
      assert.deepStrictEqual(settings.enabled_providers, ["impact"]);
      assert.deepStrictEqual(settings.disabled_providers, []);
      assert.deepStrictEqual(settings.provider.impact.whitelist, ["claude-sonnet-5-5", "gpt-6.1-sol"]);
      assert.deepStrictEqual(settings.provider.other, { npm: "custom-package" });
      assert.isUndefined(settings.provider.impact.models.stale);
      assert.deepStrictEqual(settings.permission, { bash: "ask" });
      assert.deepStrictEqual(settings.mcp, { example: { type: "local", command: ["server"] } });
    }).pipe(Effect.provide(impactHttp())),
  );

  it.effect("keeps auxiliary requests on the available small Impact model", () =>
    Effect.gen(function* () {
      const settings = settingsOf((yield* prepare()).env);
      assert.strictEqual(settings.model, "impact/gpt-6.1-sol");
      assert.strictEqual(settings.small_model, "impact/gpt-5.6-luna");
    }).pipe(
      Effect.provide(
        impactHttp(() => Response.json({ data: [...catalog.data, { ...catalog.data[1], id: "gpt-5.6-luna" }] })),
      ),
    ),
  );

  it.effect("chooses an available default when GPT 6.1 is absent", () =>
    Effect.gen(function* () {
      assert.strictEqual(settingsOf((yield* prepare()).env).model, "impact/claude-sonnet-5-5");
    }).pipe(Effect.provide(impactHttp(() => Response.json({ data: [catalog.data[0]] })))),
  );

  it.effect("rejects an unavailable explicit model instead of silently running another", () =>
    Effect.gen(function* () {
      process.env.IMPACT_MODEL = "missing";
      const error = yield* Effect.flip(prepare());
      assert.strictEqual(error.message, "Model missing is unavailable in Impact.");
    }).pipe(Effect.provide(impactHttp())),
  );

  it.effect("reports malformed inline settings without exposing their contents", () =>
    Effect.gen(function* () {
      process.env[variable] = "private invalid settings";
      const error = yield* Effect.flip(prepare());
      assert.strictEqual(error.message, `${variable} must be a JSON settings object.`);
    }).pipe(Effect.provide(impactHttp())),
  );
});

describe("OpenCode model discovery", () => {
  it.effect("exposes Opus xhigh and max exactly as advertised and disables every other effort", () =>
    Effect.gen(function* () {
      const models = yield* openCodeModels(connection);
      assert.deepStrictEqual(models["claude-opus-5-5"]!.variants, {
        none: { disabled: true },
        minimal: { disabled: true },
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
        max: { reasoningEffort: "max" },
        ultra: { disabled: true },
      });
    }).pipe(
      Effect.provide(
        impactHttp(() =>
          Response.json({
            data: [
              {
                ...catalog.data[0],
                id: "claude-opus-5-5",
                reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
              },
            ],
          }),
        ),
      ),
    ),
  );

  it.effect("maps live rates, context limits and model capabilities", () =>
    Effect.gen(function* () {
      const models = yield* openCodeModels(connection);
      expect(models["claude-sonnet-5-5"]).toMatchObject({
        id: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        tool_call: true,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 0.6, output: 3, cache_read: 0.06, cache_write: 0.75 },
      });
    }).pipe(Effect.provide(impactHttp())),
  );

  it.effect("does not advertise images, tools or reasoning for a text-only model", () =>
    Effect.gen(function* () {
      const models = yield* openCodeModels(connection);
      const model = models["custom-text"]!;
      assert.strictEqual(model.name, "custom-text");
      assert.isFalse(model.attachment);
      assert.isFalse(model.tool_call);
      assert.isFalse(model.reasoning);
      assert.isUndefined(model.interleaved);
      assert.deepStrictEqual(model.modalities.input, ["text"]);
    }).pipe(
      Effect.provide(
        impactHttp(() =>
          Response.json({
            data: [
              {
                ...catalog.data[1],
                id: "custom-text",
                display_name: undefined,
                capabilities: [],
                reasoning_efforts: [],
              },
            ],
          }),
        ),
      ),
    ),
  );

  it.effect("fails when no models are enabled", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(openCodeModels(connection));
      assert.strictEqual(error.message, "Impact has no enabled models.");
    }).pipe(Effect.provide(impactHttp(() => Response.json({ data: [] })))),
  );

  it.effect("rejects catalog prices with unsupported units", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(openCodeModels(connection));
      assert.strictEqual(error.message, "Impact returned an invalid OpenCode model catalog.");
    }).pipe(
      Effect.provide(
        impactHttp(() =>
          Response.json({
            data: [
              {
                ...catalog.data[1],
                pricing: { ...catalog.data[1]!.pricing, unit: "usd_per_token" },
              },
            ],
          }),
        ),
      ),
    ),
  );
});

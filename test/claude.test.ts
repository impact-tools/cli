import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseClaudeArgs } from "../src/clients/claude/Config.ts";
import { claudeModels, modelWindows, selectedModel } from "../src/clients/claude/Models.ts";
import { prepareClaude } from "../src/clients/claude/Prepare.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { catalog, connection, impactHttp, key } from "./support/Impact.ts";

const environment = isolatedEnvironment();
const services = Layer.mergeAll(NodeServices.layer, impactHttp());
const LaunchSettings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Any));

/** Prepares a launch and returns the single `--settings` object it passes to Claude. */
const prepare = (args: readonly string[]) =>
  Effect.gen(function* () {
    const prepared = yield* prepareClaude({ executable: "claude", args, connection });
    const index = prepared.args.indexOf("--settings");
    return {
      ...prepared,
      settings: yield* Schema.decodeEffect(LaunchSettings)(prepared.args[index + 1]!),
      rest: prepared.args.slice(index + 2),
    };
  });

describe("parseClaudeArgs", () => {
  it("removes every --settings form and keeps the rest of argv in order", () => {
    const parsed = parseClaudeArgs(["--settings", "a.json", "-p", "x", "--settings={}", "--", "literal"]);
    assert.deepStrictEqual(parsed.settings, ["a.json", "{}"]);
    assert.deepStrictEqual(parsed.args, ["-p", "x", "--", "literal"]);
  });

  it("reads --model and --setting-sources", () => {
    const parsed = parseClaudeArgs(["--model", "gpt-6.1-sol", "--setting-sources", "project"]);
    assert.strictEqual(parsed.model, "gpt-6.1-sol");
    assert.deepStrictEqual(parsed.sources, ["project"]);
  });
});

describe("modelWindows", () => {
  it("sets the window for large non-Claude models unless the user chose a fitting one", () => {
    assert.deepStrictEqual(modelWindows(catalog.data, {}), { "gpt-6.1-sol": { autoCompactWindow: 272_000 } });
    assert.deepStrictEqual(
      modelWindows(catalog.data, { modelSettings: { "gpt-6.1-sol": { autoCompactWindow: 160_000 } } }),
      {},
    );
    assert.deepStrictEqual(modelWindows(catalog.data, { autoCompactWindow: 500_000 }), {
      "gpt-6.1-sol": { autoCompactWindow: 272_000 },
    });
  });
});

describe("selectedModel", () => {
  it("resolves aliases internally with exact IDs taking precedence", () => {
    const canonical = { id: "claude-opus-5-5", max_input_tokens: 1_000_000 };
    for (const id of [canonical.id, "claude-opus-5.5", "opus-5-5", "opus-5.5[1m]", "OPUS-5.5"])
      assert.strictEqual(selectedModel([canonical], id), canonical);
    const exact = { id: "opus-5.5", max_input_tokens: 200_000 };
    assert.strictEqual(selectedModel([canonical, exact], exact.id), exact);
    assert.isUndefined(selectedModel([canonical], "claude/opus-5.5"));
    assert.isUndefined(selectedModel([canonical], "unknown"));
    assert.isUndefined(selectedModel([canonical], undefined));
    assert.isUndefined(selectedModel([{ ...canonical, max_input_tokens: 200_000 }], "opus-5.5[1m]"));
    assert.isUndefined(selectedModel([{ id: canonical.id }], "opus-5.5[1m]"));
  });
});

describe("prepareClaude", () => {
  it.effect("ignores alias metadata from older servers when building the picker", () =>
    Effect.gen(function* () {
      const result = yield* claudeModels(connection);
      assert.deepStrictEqual(result.modelPicker.options, [
        { model: "claude-opus-5-5", label: "Opus 5.5", description: "Opus 5.5" },
      ]);
      assert.notProperty(result.models[0]!, "aliases");
    }).pipe(
      Effect.provide(
        impactHttp(() =>
          Response.json({
            data: [{ id: "claude-opus-5-5", display_name: "Opus 5.5", aliases: ["opus-5.5", "opus-5.5[1m]"] }],
          }),
        ),
      ),
    ),
  );
  it.effect("keeps the picker canonical and resolves internal aliases at launch", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare(["--model", "opus-5.5[1m]"]);
      assert.strictEqual(prepared.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
      assert.deepStrictEqual(prepared.rest, ["--model", "opus-5.5[1m]"]);
      assert.deepStrictEqual(
        prepared.settings.modelPicker.options.map((row: { model: string }) => row.model),
        ["claude-opus-5-5"],
      );
      const configured = yield* prepare(["--settings", JSON.stringify({ model: "claude-opus-5.5[1m]" })]);
      assert.strictEqual(configured.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "160000";
      const override = yield* prepare(["--model", "opus-5.5[1m]"]);
      assert.strictEqual(override.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "160000");
      assert.notProperty(override.settings.env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          impactHttp((url) =>
            Response.json(
              url.pathname === "/v1/models"
                ? { data: [{ id: "claude-opus-5-5", max_input_tokens: 1_000_000 }] }
                : {
                    currency: "USD",
                    account: { id: "ada", email: "ada@example.com" },
                    credits: { balance: "12.345", reserved: "0", total: "12.345" },
                  },
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("routes Claude to Impact without putting the key in argv", () =>
    Effect.gen(function* () {
      process.env.CLAUDE_CODE_USE_VERTEX = "1";
      const prepared = yield* prepare(["-p", "hello"]);
      assert.deepStrictEqual(prepared.rest, ["-p", "hello"]);
      assert.notInclude(prepared.args.join(" "), key);
      assert.strictEqual(prepared.env.ANTHROPIC_BASE_URL, connection.baseUrl);
      assert.strictEqual(prepared.env.CLAUDE_CODE_USE_VERTEX, "0");
      assert.strictEqual(prepared.env.IMPACT_API_KEY, key);
      expect(prepared.settings.apiKeyHelper).toMatch(/'helper' 'token'$/);
      expect(prepared.settings.statusLine.command).toMatch(/'helper' 'status-line'$/);
      assert.deepStrictEqual(prepared.settings.modelPicker, {
        replaceBuiltInOptions: true,
        options: [
          { model: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Sonnet 5.5" },
          { model: "gpt-6.1-sol", label: "GPT 6.1", description: "GPT 6.1" },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("leaves model choices to Claude and sizes the context for the selected model", () =>
    Effect.gen(function* () {
      process.env.ANTHROPIC_MODEL = "gpt-6.1-sol";
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "custom-opus";
      const { settings, env } = yield* prepare([]);
      assert.notProperty(settings.env, "ANTHROPIC_MODEL");
      assert.notProperty(settings.env, "ANTHROPIC_DEFAULT_OPUS_MODEL");
      assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "custom-opus");
      assert.strictEqual(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
      assert.strictEqual(settings.modelSettings["gpt-6.1-sol"].autoCompactWindow, 272_000);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("merges --settings, keeps the user's status line options and leaves settings files alone", () =>
    Effect.gen(function* () {
      const userSettings = join(environment.directory, "settings.json");
      const original = JSON.stringify({
        model: "gpt-6.1-sol",
        statusLine: { type: "command", command: "echo custom", padding: 3 },
      });
      yield* Effect.promise(() => writeFile(userSettings, original));
      const custom = {
        env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "my-haiku" },
        permissions: { allow: ["Read"] },
        modelSettings: { "gpt-6.1-sol": { autoCompactWindow: 160_000, effortLevel: "low" } },
      };
      const prepared = yield* prepare(["--settings", JSON.stringify(custom), "-p", "hello"]);
      assert.strictEqual(prepared.args.filter((arg) => arg === "--settings").length, 1);
      assert.deepStrictEqual(prepared.rest, ["-p", "hello"]);
      expect(prepared.settings.env).toMatchObject(custom.env);
      assert.deepStrictEqual(prepared.settings.permissions, custom.permissions);
      assert.deepStrictEqual(prepared.settings.modelSettings["gpt-6.1-sol"], custom.modelSettings["gpt-6.1-sol"]);
      assert.notProperty(prepared.settings, "model");
      assert.strictEqual(prepared.settings.statusLine.padding, 3);
      assert.strictEqual(prepared.settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
      const snapshot = JSON.parse(
        yield* Effect.promise(() => readFile(prepared.env.IMPACT_CLAUDE_STATUS_FILE!, "utf8")),
      );
      assert.deepStrictEqual(snapshot, { line: "Impact · ada@example.com · $14.845 USD", command: "echo custom" });
      assert.strictEqual(yield* Effect.promise(() => readFile(userSettings, "utf8")), original);
      return prepared.env.IMPACT_CLAUDE_STATUS_FILE!;
    }).pipe(
      Effect.scoped,
      Effect.flatMap((statusFile) =>
        Effect.promise(() =>
          stat(statusFile).then(
            () => "kept",
            () => "removed",
          ),
        ),
      ),
      Effect.map((state) => assert.strictEqual(state, "removed")),
      Effect.provide(services),
    ),
  );

  it.effect("reports an unreadable --settings file", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(prepare(["--settings", join(environment.directory, "missing.json")]));
      expect(error.message).toContain("Cannot read Claude settings");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

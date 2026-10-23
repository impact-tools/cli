import { Effect, Option, Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";

import { getJson } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { claudeAliases } from "../../schemas/ModelVocabulary.ts";

const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      max_input_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      max_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
});
type Model = (typeof Catalog.Type.data)[number];

const CompactWindow = Schema.Union([
  Schema.Int.check(Schema.isBetween({ minimum: 100_000, maximum: 1_000_000 })),
  Schema.Literal("auto"),
]);
const CompactSettings = Schema.Struct({
  autoCompactWindow: Schema.optional(CompactWindow),
  modelSettings: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ autoCompactWindow: Schema.optional(CompactWindow) })),
  ),
});

/**
 * The listed model a `--model` or settings value names. The list doesn't say which models are pinned
 * to a dated snapshot, so a `-YYYYMMDD` suffix on any Claude model's name selects the model itself.
 */
export function selectedModel(models: readonly Model[], id: string | undefined): Model | undefined {
  if (id === undefined || id.includes("/")) return undefined;
  const named = (name: string) =>
    models.find(
      (model) =>
        model.id === name || claudeAliases({ id: model.id, contextTokens: model.max_input_tokens ?? 0 }).includes(name),
    );
  const lowered = id.toLowerCase();
  return models.find((model) => model.id === id) ?? named(lowered) ?? named(lowered.replace(/-\d{8}(?=\[1m\]$|$)/, ""));
}

/**
 * The compaction window a non-Claude model gets: its own context, within the 100k to 1M range
 * Claude Code accepts for `autoCompactWindow`. Claude models and smaller ones are left to Claude.
 */
const ownWindow = (model: Model) =>
  model.id.startsWith("claude-") || !model.max_input_tokens || model.max_input_tokens < 100_000
    ? undefined
    : Math.min(model.max_input_tokens, 1_000_000);

/** Compaction windows for non-Claude models that Claude Code does not know, unless the user chose a fitting one. */
export function modelWindows(models: readonly Model[], settings: Record<string, unknown>) {
  const saved: typeof CompactSettings.Type = Option.getOrElse(
    Schema.decodeOption(CompactSettings)(settings),
    () => ({}),
  );
  return Object.fromEntries(
    models.flatMap((model) => {
      const maximum = ownWindow(model);
      if (maximum === undefined) return [];
      const selected = saved.modelSettings?.[model.id]?.autoCompactWindow ?? saved.autoCompactWindow;
      if (selected === "auto" || typeof selected === "number" && selected <= maximum) return [];
      return [[model.id, { autoCompactWindow: maximum }]];
    }),
  );
}

/**
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: the context Claude Code assumes for every model it doesn't know
 * (200k without it), one value for the whole session. A model picked later with `/model` gets it
 * too, so it is the largest window the launch may need: the selected model's, or any non-Claude
 * model's. Claude Code compacts within the smaller of it and a model's `autoCompactWindow`, so each
 * smaller model is still held to its own.
 */
export function unknownModelContext(models: readonly Model[], selected: Model | undefined) {
  const windows = [selected?.max_input_tokens, ...models.map(ownWindow)].filter(
    (window): window is number => window !== undefined,
  );
  return windows.length === 0 ? undefined : Math.max(...windows);
}

export const claudeModels = Effect.fn("claudeModels")(function* (connection: Connection) {
  const catalog = yield* getJson(connection, "/v1/models", Catalog, {
    headers: { "anthropic-version": "2023-06-01" },
    invalid: "Impact returned an invalid Claude model catalog.",
  });
  if (catalog.data.length === 0) return yield* new CliError({ message: "Impact has no enabled models." });
  return {
    models: catalog.data,
    modelPicker: {
      replaceBuiltInOptions: true,
      options: catalog.data.map((model) => ({
        model: model.id,
        label: model.display_name ?? model.id,
        description: model.description ?? model.display_name ?? "From Impact",
      })),
    },
  };
});

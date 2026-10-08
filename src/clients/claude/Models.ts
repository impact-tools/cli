import { Effect, Option, Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";

import { getJson } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { catalogAliases } from "../../schemas/Catalog.ts";

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

export function selectedModel(models: readonly Model[], id: string | undefined): Model | undefined {
  if (id === undefined || id.includes("/")) return undefined;
  return (
    models.find((model) => model.id === id) ??
    models.find((model) =>
      catalogAliases({ id: model.id, contextTokens: model.max_input_tokens ?? 0 }).includes(id.toLowerCase()),
    )
  );
}

/** Compaction windows for non-Claude models that Claude Code does not know, unless the user chose a fitting one. */
export function modelWindows(models: readonly Model[], settings: Record<string, unknown>) {
  const saved: typeof CompactSettings.Type = Option.getOrElse(
    Schema.decodeOption(CompactSettings)(settings),
    () => ({}),
  );
  return Object.fromEntries(
    models.flatMap((model) => {
      if (model.id.startsWith("claude-") || !model.max_input_tokens || model.max_input_tokens < 100_000) return [];
      const maximum = Math.min(model.max_input_tokens, 1_000_000);
      const selected = saved.modelSettings?.[model.id]?.autoCompactWindow ?? saved.autoCompactWindow;
      if (typeof selected === "number" && selected <= maximum) return [];
      return [[model.id, { autoCompactWindow: maximum }]];
    }),
  );
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

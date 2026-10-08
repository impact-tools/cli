import { catalogModel, MODEL_EFFORTS } from "@impact-llm/schemas";
import { Effect, Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";

import { getJson } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";

const Tokens = Schema.Int.check(Schema.isGreaterThan(0));
const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      display_name: Schema.optional(Schema.String),
      context_length: Tokens,
      max_output_tokens: Tokens,
      capabilities: Schema.Array(Schema.String),
      reasoning_efforts: Schema.Array(Schema.String),
      pricing: Schema.Struct({
        input: Price,
        output: Price,
        cached_input: Price,
        cache_write: Price,
        unit: Schema.Literal("usd_per_1m_tokens"),
      }),
    }),
  ),
});

/** OpenCode adds its own efforts to reasoning models; Kilo doesn't. Both drop disabled variants. */
const variants = (efforts: readonly string[]) => ({
  ...Object.fromEntries(MODEL_EFFORTS.map((effort) => [effort, { disabled: true }])),
  ...Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
});

/** Model definitions in the provider format OpenCode and its fork Kilo share. */
export const openCodeModels = Effect.fn("openCodeModels")(function* (connection: Connection) {
  const catalog = yield* getJson(connection, "/v1/models", Catalog, {
    invalid: "Impact returned an invalid OpenCode model catalog.",
  });
  if (catalog.data.length === 0) return yield* new CliError({ message: "Impact has no enabled models." });
  return Object.fromEntries(
    catalog.data.map((model) => {
      const reasoning = model.reasoning_efforts.some((effort) => effort !== "none");
      const vision = model.capabilities.includes("vision");
      return [
        model.id,
        {
          id: model.id,
          name: model.display_name ?? catalogModel(model.id)?.name ?? model.id,
          tool_call: model.capabilities.includes("tools"),
          reasoning,
          variants: variants(model.reasoning_efforts),
          attachment: vision,
          modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
          ...(reasoning ? { interleaved: { field: "reasoning_content" } } : {}),
          limit: { context: model.context_length, output: model.max_output_tokens },
          cost: {
            input: model.pricing.input,
            output: model.pricing.output,
            cache_read: model.pricing.cached_input,
            cache_write: model.pricing.cache_write,
          },
        },
      ] as const;
    }),
  );
});

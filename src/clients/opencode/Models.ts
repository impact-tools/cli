import { Effect, Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";

import { getJson } from "../../api/Http.ts";
import { CliError } from "../../Errors.ts";
import { fromModelList } from "../../setup/Models.ts";
import { openCodeModel } from "../../setup/OpenCode.ts";

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

/** Impact's models from `GET /v1/models`, as the setup generator describes them. */
export const impactModels = Effect.fn("impactModels")(function* (connection: Connection) {
  const catalog = yield* getJson(connection, "/v1/models", Catalog, {
    invalid: "Impact returned an invalid OpenCode model catalog.",
  });
  if (catalog.data.length === 0) return yield* new CliError({ message: "Impact has no enabled models." });
  return fromModelList(catalog.data);
});

/** Model definitions in the provider format OpenCode and its fork Kilo share, by id. */
export const openCodeModels = (connection: Connection) =>
  impactModels(connection).pipe(
    Effect.map((models) => Object.fromEntries(models.map((model) => [model.id, openCodeModel(model)]))),
  );

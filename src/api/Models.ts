import { Effect, Schema } from "effect";

import type { Connection } from "../config/Connection.ts";

import { getJson } from "./Http.ts";

const Catalog = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** Verifies the endpoint and key; returns the number of enabled models. */
export const countModels = (connection: Connection) =>
  getJson(connection, "/v1/models", Catalog, {
    invalid: "This endpoint did not return an Impact model catalog. Check the base URL.",
  }).pipe(Effect.map((catalog) => catalog.data.length));

import { Effect } from "effect";

import type { Connection } from "../config/Connection.ts";

import { ModelIdList } from "../schemas/V1.ts";
import { getJson } from "./Http.ts";

/** Verifies the endpoint and key; returns the number of enabled models. */
export const countModels = (connection: Connection) =>
  getJson(connection, "/v1/models", ModelIdList, {
    invalid: "This endpoint did not return an Impact model catalog. Check the base URL.",
  }).pipe(Effect.map((catalog) => catalog.data.length));

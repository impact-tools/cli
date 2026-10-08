import { Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";

import { getJson } from "../../api/Http.ts";

const CodexModels = Schema.Struct({
  models: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ slug: Schema.String, base_instructions: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
});

export const codexModels = (connection: Connection, version: string) =>
  getJson(connection, `/v1/models?client_version=${encodeURIComponent(version)}`, CodexModels, {
    timeout: "20 seconds",
    invalid: "Impact returned an invalid Codex model catalog.",
  });

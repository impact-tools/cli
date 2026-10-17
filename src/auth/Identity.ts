import { Redacted } from "effect";
import { createHash } from "node:crypto";

import type { Connection } from "../config/Connection.ts";

/** Identifies an Impact login without exposing its API key. */
export const loginId = (connection: Connection) =>
  createHash("sha256").update(`${connection.baseUrl}\n${Redacted.value(connection.apiKey)}`).digest("base64url").slice(0, 22);

import type { Duration } from "effect";

import type { Connection } from "../config/Connection.ts";

import { UsageSpend } from "../schemas/Spend.ts";
import { getJson } from "./Http.ts";

export const fetchSpend = (connection: Connection, timeout?: Duration.Input) =>
  getJson(connection, "/v1/usage/spend", UsageSpend, {
    timeout,
    invalid: "Impact returned invalid spending data.",
  });

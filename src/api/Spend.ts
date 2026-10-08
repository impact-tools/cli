import type { Duration } from "effect";

import { UsageSpend } from "@impact-llm/schemas";

import type { Connection } from "../config/Connection.ts";

import { getJson } from "./Http.ts";

export const fetchSpend = (connection: Connection, timeout?: Duration.Input) =>
  getJson(connection, "/v1/usage/spend", UsageSpend, {
    timeout,
    invalid: "Impact returned invalid spending data.",
  });

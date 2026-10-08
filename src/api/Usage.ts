import { Schema, type Duration } from "effect";

import type { Connection } from "../config/Connection.ts";

import { getJson } from "./Http.ts";

const Usage = Schema.Struct({
  currency: Schema.Literal("USD"),
  account: Schema.optional(Schema.Struct({ id: Schema.String, email: Schema.String })),
  credits: Schema.Struct({
    balance: Schema.String,
    reserved: Schema.optional(Schema.String),
    total: Schema.optional(Schema.String),
  }),
});
export type Usage = typeof Usage.Type;

export const fetchUsage = (connection: Connection, timeout?: Duration.Input) =>
  getJson(connection, "/v1/usage", Usage, { timeout, invalid: "Impact returned an invalid wallet balance." });

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** The wallet total includes holds; older servers only report the available balance. */
export const walletBalance = (usage: Usage): string => usage.credits.total ?? usage.credits.balance;

/** `Impact · email · $balance USD`, with control characters removed for terminal status lines. */
export const usageSummary = (connection: Connection, usage: Usage) =>
  `Impact · ${clean(usage.account?.email ?? connection.baseUrl)} · $${clean(walletBalance(usage))} USD`;

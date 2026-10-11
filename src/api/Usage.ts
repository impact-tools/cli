import type { Duration } from "effect";

import type { Connection } from "../config/Connection.ts";

import { UsageWallet } from "../schemas/V1.ts";
import { getJson } from "./Http.ts";

export type Usage = UsageWallet;

export const fetchUsage = (connection: Connection, timeout?: Duration.Input) =>
  getJson(connection, "/v1/usage", UsageWallet, { timeout, invalid: "Impact returned an invalid wallet balance." });

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** The wallet total includes holds; older servers only report the available balance. */
export const walletBalance = (usage: Usage): string => usage.credits.total ?? usage.credits.balance;

/** `Impact · email · $balance USD`, with control characters removed for terminal status lines. */
export const usageSummary = (connection: Connection, usage: Usage) =>
  `Impact · ${clean(usage.account?.email ?? connection.baseUrl)} · $${clean(walletBalance(usage))} USD`;

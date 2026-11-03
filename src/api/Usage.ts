import { Schema, type Duration } from "effect";

import type { Connection } from "../config/Connection.ts";

import { UsagePlanCredits } from "../schemas/V1.ts";
import { getJson } from "./Http.ts";

const Usage = Schema.Struct({
  currency: Schema.Literal("USD"),
  account: Schema.optional(Schema.Struct({ id: Schema.String, email: Schema.String })),
  credits: Schema.Struct({
    balance: Schema.String,
    reserved: Schema.optional(Schema.String),
    total: Schema.optional(Schema.String),
  }),
  /** The plan credits of the paid period running now: null on Free, absent from servers before them. */
  plan_credits: Schema.optional(Schema.NullOr(UsagePlanCredits)),
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

/** The day a period's plan credits end, `Nov 29`: periods last 30 days, so the year goes without saying. */
const creditsEnd = (endsAt: number): string | undefined => {
  const date = new Date(endsAt * 1000);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
};

/**
 * What is left of the plan credits of the running period, `$12.3 USD left of $15 USD · until Nov 29`;
 * undefined on Free and from servers before plan credits.
 */
export const planCreditsLeft = (usage: Usage): string | undefined => {
  const credits = usage.plan_credits;
  if (credits == null) return undefined;
  const left = `$${clean(credits.remaining)} USD left of $${clean(credits.granted)} USD`;
  const end = creditsEnd(credits.ends_at);
  return end === undefined ? left : `${left} · until ${end}`;
};

/**
 * One line for the landing screen and Claude's status line: {@link usageSummary}, then what is left of
 * the plan credits, which pay before the balance, when the plan has them.
 */
export const accountSummary = (connection: Connection, usage: Usage) => {
  const credits = usage.plan_credits;
  const summary = usageSummary(connection, usage);
  return credits == null ? summary : `${summary} · Plan credits $${clean(credits.remaining)} USD left`;
};

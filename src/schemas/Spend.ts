import { Schema } from "effect";

/** Wallet charges in the dashboard's seven-day bucket window, in integer USD micros. */
export const UsageSpend = Schema.Struct({
  currency: Schema.Literal("USD"),
  startAt: Schema.Finite,
  asOf: Schema.Finite,
  totalMicros: Schema.Int,
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      chargedMicros: Schema.Int,
    }),
  ),
});
export type UsageSpend = typeof UsageSpend.Type;

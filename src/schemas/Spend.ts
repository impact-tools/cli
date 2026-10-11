import { Schema } from "effect";

/** `/v1/usage/spend` covers this many buckets of {@link SPEND_BUCKET_MS}: seven days. */
export const SPEND_BUCKETS = 42;
export const SPEND_BUCKET_MS = 4 * 60 * 60 * 1000;

/** The start of the spend window: {@link SPEND_BUCKETS} epoch-aligned buckets, ending with the one `now` is in. */
export const spendStartAt = (now: number): number =>
  (Math.floor(now / SPEND_BUCKET_MS) + 1 - SPEND_BUCKETS) * SPEND_BUCKET_MS;

/**
 * How the traffic rollups break traffic down. `api_key` is keyed by the key's id (`none` without
 * one) and written for users only; `model_funding` is keyed `<model>:<funding>`.
 */
export const TRAFFIC_DIMENSIONS = [
  "total",
  "model",
  "client",
  "funding",
  "upstream",
  "endpoint",
  "error",
  "api_key",
  "model_funding",
] as const;
export type TrafficDimension = (typeof TRAFFIC_DIMENSIONS)[number];

/** Wallet charges in the spend window ({@link spendStartAt}), in integer USD micros. */
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

import { Schema } from "effect";

/** Millionths of a US dollar: sub-cent prices stay integers all the way into the ledger. */
export type UsdMicros = number;

export const USD_MICROS = 1_000_000;

/**
 * Billionths of a micro-dollar: a price per million tokens is micro-dollars per token, so this unit
 * holds every price in whole numbers and the ledger adds them up without floating-point noise.
 */
export const PRICE_NANOS = 1_000_000_000;

/** A price in {@link PRICE_NANOS} per token; exact for every price {@link TokenPrices} accepts. */
export const priceNanos = (price: number): number => Math.round(price * PRICE_NANOS);

/** Whole billionths of a micro-dollar per token, so the ledger can add prices up exactly. */
const isExactPrice = Schema.makeFilter(
  (price: number) =>
    (Number.isSafeInteger(priceNanos(price)) && priceNanos(price) / PRICE_NANOS === price) ||
    "a token price takes at most nine decimal places",
);

const TokenPrice = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), isExactPrice);

/** One set of token prices in USD per million tokens: a vendor's list price or our tariff. */
export const TokenPrices = Schema.Struct({
  /** Uncached input tokens. */
  input: TokenPrice,
  output: TokenPrice,
  /** Input tokens read from the vendor's prompt cache. */
  cachedInput: TokenPrice,
  /** Tokens written to the cache, at the default TTL where the vendor has several. */
  cacheWrite: TokenPrice,
  /** Tokens written with a one-hour cache TTL, where the vendor sells it. */
  cacheWrite1h: Schema.optionalKey(TokenPrice),
});
export type TokenPrices = typeof TokenPrices.Type;

/**
 * Operator-configured models (`OPENAI_COMPATIBLE_MODELS_JSON`) are charged this share of the reference
 * prices they declare. Catalog models carry explicit tariffs instead.
 */
export const MODEL_PRICE_MULTIPLIER = 0.2;

/**
 * Prices of the calls the gateway makes on a model's behalf (the sidecars), charged per call on
 * top of the model's own tokens. Failed calls are free.
 */
export const SIDECAR_PRICES = {
  /**
   * The least one new image description for a text-only model costs: a longer one costs its call's
   * usage at the vision model's tariff. A user's image described within the last day is free.
   */
  imageDescription: 500,
} as const satisfies Record<string, UsdMicros>;

/**
 * Anthropic's server-side web search, per search ($10 per 1,000 list price). Charged at the Claude
 * model's tariff share of list (`tariffFeeMicros`), like its tokens.
 */
export const ANTHROPIC_WEB_SEARCH_MICROS = 10_000;

export const usdFromMicros = (micros: UsdMicros) => micros / USD_MICROS;

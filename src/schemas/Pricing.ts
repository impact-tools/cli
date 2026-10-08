import { Schema } from "effect";

/** Millionths of a US dollar: sub-cent prices stay integers all the way into the ledger. */
export type UsdMicros = number;

export const USD_MICROS = 1_000_000;

const TokenPrice = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

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
 * Flat prices of the calls the gateway makes on a model's behalf (the sidecars), charged per
 * call on top of the model's own tokens, whatever upstream answered them. Failed calls are free.
 */
export const SIDECAR_PRICES = {
  /** One new image described for a text-only model; repeats within a turn are free. */
  imageDescription: 500,
} as const satisfies Record<string, UsdMicros>;

/**
 * Anthropic's server-side web search, per search ($10 per 1,000 list price). Charged at the Claude
 * model's tariff share of list (`tariffFeeMicros`), like its tokens.
 */
export const ANTHROPIC_WEB_SEARCH_MICROS = 10_000;

export type SidecarKind = keyof typeof SIDECAR_PRICES;

export const usdFromMicros = (micros: UsdMicros) => micros / USD_MICROS;

import { Schema } from "effect";

import anthropicModels from "./catalog/anthropic.json";
import googleModels from "./catalog/google.json";
import openaiModels from "./catalog/openai.json";
import uncensoredModels from "./catalog/uncensored.json";
import xaiModels from "./catalog/xai.json";
import { MODEL_PRICE_MULTIPLIER, TokenPrices, USD_MICROS, type UsdMicros } from "./Pricing.ts";

/**
 * The model catalog: one JSON file per vendor under `catalog/`, listing each model with its vendor's
 * list prices (`official`) and our tariff, in USD per million tokens. The uncensored line's `official`
 * prices are Impact's reference rates. These are the defaults; admins override prices per model
 * (see `ModelPricing.ts`).
 *
 * Grok is served by Cursor by default, so its window and effort ladders are the ones Cursor's wire
 * takes. That wire carries no images: they reach Grok through image descriptions.
 */

const VENDORS = ["openai", "anthropic", "google", "xai", "uncensored"] as const;
export type VendorId = (typeof VENDORS)[number];

const CAPABILITIES = ["reasoning", "vision", "tools", "audio"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Reasoning efforts, lowest first; the same ladder the gateway's canonical request uses. */
export const MODEL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/**
 * Who can serve the model. `chatgpt` models also run on ChatGPT accounts (BYOK and the global
 * pool); every family has an operator key behind it for the balance.
 */
const SERVERS = ["openai", "anthropic", "google", "impact", "cursor", "kiro", "compatible"] as const;
export type ServedBy = (typeof SERVERS)[number];

export interface CatalogModel {
  /** What goes in the request's `model` field. */
  readonly id: string;
  readonly name: string;
  readonly vendor: VendorId;
  readonly summary: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** Our tariff: USD per million uncached input tokens. */
  readonly inputPrice: number;
  readonly outputPrice: number;
  /** USD per million input tokens read from the vendor's prompt cache. */
  readonly cachedInputPrice: number;
  /** USD per million tokens written to the cache, where the vendor bills writes separately. */
  readonly cacheWritePrice: number;
  /** USD per million tokens written with a one-hour cache TTL, when supported. */
  readonly cacheWrite1hPrice?: number;
  /** The vendor's list prices, which the tariff above is set against. */
  readonly official: TokenPrices;
  readonly capabilities: readonly Capability[];
  readonly preview?: boolean;
  /** The id on the vendor's own wire. */
  readonly wireModel: string;
  readonly servedBy: ServedBy;
  /** Efforts the model accepts, lowest first; empty when it doesn't reason. */
  readonly efforts: readonly ModelEffort[];
  /** ChatGPT accounts can serve it through Codex. */
  readonly chatgpt: boolean;
  /** Operator's multiplier for native priority requests; absent when unavailable. */
  readonly priorityPriceMultiplier?: number;
  /** Internal routing candidates; never published as separate client models. */
  readonly routingSources?: readonly CatalogModel[];
}

/** Output dominates real bills, so a model's typical price weights it 3:1 over input. */
export const blendedPrice = (model: Pick<CatalogModel, "inputPrice" | "outputPrice">) =>
  (model.inputPrice + model.outputPrice * 3) / 4;

type TariffFields = Pick<
  CatalogModel,
  "inputPrice" | "outputPrice" | "cachedInputPrice" | "cacheWritePrice" | "cacheWrite1hPrice"
>;

/** A tariff in the flat price fields the ledger reads. */
export const tariffFields = (tariff: TokenPrices): TariffFields => ({
  inputPrice: tariff.input,
  outputPrice: tariff.output,
  cachedInputPrice: tariff.cachedInput,
  cacheWritePrice: tariff.cacheWrite,
  ...(tariff.cacheWrite1h === undefined ? {} : { cacheWrite1hPrice: tariff.cacheWrite1h }),
});

/** The model's tariff, read back from its flat price fields. */
export const modelTariff = (model: TariffFields): TokenPrices => ({
  input: model.inputPrice,
  output: model.outputPrice,
  cachedInput: model.cachedInputPrice,
  cacheWrite: model.cacheWritePrice,
  ...(model.cacheWrite1hPrice === undefined ? {} : { cacheWrite1h: model.cacheWrite1hPrice }),
});

const CatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  contextTokens: Schema.Int,
  maxOutputTokens: Schema.Int,
  capabilities: Schema.Array(Schema.Literals(CAPABILITIES)),
  efforts: Schema.Array(Schema.Literals(MODEL_EFFORTS)),
  preview: Schema.optionalKey(Schema.Boolean),
  wireModel: Schema.String,
  servedBy: Schema.Literals(SERVERS),
  chatgpt: Schema.Boolean,
  official: TokenPrices,
  tariff: TokenPrices,
}).check(
  Schema.makeFilter(
    ({ id, official, tariff }) =>
      (official.cacheWrite1h === undefined) === (tariff.cacheWrite1h === undefined) ||
      `${id} prices one-hour cache writes in only one of official and tariff`,
  ),
);

const CatalogFiles = Schema.Array(
  Schema.Struct({ vendor: Schema.Literals(VENDORS), models: Schema.Array(CatalogEntry) }),
).check(
  Schema.makeFilter((files) => {
    const ids = files.flatMap((file) => file.models.map((model) => model.id));
    return new Set(ids).size === ids.length || "model ids must be unique across the catalog";
  }),
);

/** Newest first within each vendor; the models page keeps this order unless sorted. */
export const CATALOG: readonly CatalogModel[] = Schema.decodeUnknownSync(CatalogFiles)([
  openaiModels,
  anthropicModels,
  googleModels,
  xaiModels,
  uncensoredModels,
]).flatMap(({ vendor, models }) =>
  models.map(({ tariff: prices, ...model }): CatalogModel => ({ ...model, vendor, ...tariffFields(prices) })),
);

/** Normalize rates before the ledger rounds token charges up to whole micro-dollars. */
const tariff = (price: number): number => Math.round(price * MODEL_PRICE_MULTIPLIER * USD_MICROS) / USD_MICROS;

/** An operator-configured model, charged {@link MODEL_PRICE_MULTIPLIER} of the reference prices it declares. */
export const applyModelTariff = (model: Omit<CatalogModel, "official">): CatalogModel => ({
  ...model,
  official: modelTariff(model),
  inputPrice: tariff(model.inputPrice),
  outputPrice: tariff(model.outputPrice),
  cachedInputPrice: tariff(model.cachedInputPrice),
  cacheWritePrice: tariff(model.cacheWritePrice),
  ...(model.cacheWrite1hPrice === undefined ? {} : { cacheWrite1hPrice: tariff(model.cacheWrite1hPrice) }),
});

const BY_ID = new Map(CATALOG.map((model) => [model.id, model]));

export const catalogModel = (id: string): CatalogModel | undefined => BY_ID.get(id);

/** The model that answers the gateway's `web_search` unless the server names another; searches are priced at it. */
export const SEARCH_MODEL_ID = "gemini-3.8-flash";

/** Token counts as the ledger prices them; `inputTokens` includes cached and cache-write tokens. */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheCreation1hTokens?: number;
  readonly outputTokens: number;
}

/**
 * What the tokens cost at the public tariff. A price per million tokens is exactly the price in micros
 * per token, so this is a plain dot product, rounded up to the next micro.
 */
export const tokenCostMicros = (model: CatalogModel, tokens: TokenCounts): UsdMicros => {
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const written = Math.min(tokens.cacheWriteTokens, tokens.inputTokens - cached);
  const written1h = Math.min(tokens.cacheCreation1hTokens ?? 0, written);
  const uncached = tokens.inputTokens - cached - written;
  return Math.ceil(
    uncached * model.inputPrice +
      cached * model.cachedInputPrice +
      (written - written1h) * model.cacheWritePrice +
      written1h * (model.cacheWrite1hPrice ?? model.cacheWritePrice) +
      tokens.outputTokens * model.outputPrice,
  );
};

/** The share of its vendor's list prices the model's tariff charges, on blended prices. */
export const tariffShare = (model: Pick<CatalogModel, "inputPrice" | "outputPrice" | "official">) => {
  const list = blendedPrice({ inputPrice: model.official.input, outputPrice: model.official.output });
  return list > 0 ? blendedPrice(model) / list : 1;
};

/**
 * A per-call fee the vendor lists, such as a web search, at the model's {@link tariffShare}: a
 * model sold at 8% of list sells its searches at 8% of list too. Rounded to the nearest micro.
 */
export const tariffFeeMicros = (
  model: Pick<CatalogModel, "inputPrice" | "outputPrice" | "official">,
  listMicros: UsdMicros,
): UsdMicros => Math.round(listMicros * tariffShare(model));

const claudeSpellings = (id: string): readonly string[] => {
  const dotted = id.replace(/(\d+)-(\d+)(?=-\d{8}$|$)/, "$1.$2");
  return [id, dotted, id.slice(7), dotted.slice(7)];
};

/**
 * Public Claude spellings; context suffixes never change the upstream model ID.
 * Models pinned to dated snapshots also accept the snapshot's spellings.
 */
export const catalogAliases = (model: Pick<CatalogModel, "id" | "contextTokens">): readonly string[] => {
  if (!/^claude-(?:opus|sonnet|haiku|fable)-/.test(model.id)) return [];
  const snapshot = BY_ID.get(model.id)?.wireModel;
  const pinned =
    snapshot !== undefined && /^-\d{8}$/.test(snapshot.slice(model.id.length)) && snapshot.startsWith(model.id);
  const names = [...new Set([model.id, ...(pinned ? [snapshot] : [])].flatMap(claudeSpellings))];
  return [
    ...names.filter((id) => id !== model.id),
    ...(model.contextTokens >= 1_000_000 ? names.map((id) => `${id}[1m]`) : []),
  ];
};

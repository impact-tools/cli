import { Schema } from "effect";
import { Rpc } from "effect/rpc";

import { CATALOG, DEFAULT_SEARCH_EFFORT, SEARCH_EFFORTS, SEARCH_MODEL_ID, searchTarget } from "./Catalog.ts";
import { Forbidden, NotFound } from "./Errors.ts";

/** Instants are Unix ms; money is micro-USD integers throughout. */
const Instant = Schema.Finite;
const Micros = Schema.Int;

/** What can pay for a request: your own accounts, the plan's included usage, or credits. */
export const FundingSource = Schema.Literals(["byok", "subscription", "balance"]);
export type FundingSource = typeof FundingSource.Type;

/** One step of a key's billing order; disabled steps keep their place. */
export const FundingStep = Schema.Struct({ source: FundingSource, enabled: Schema.Boolean });
export type FundingStep = typeof FundingStep.Type;

export const DEFAULT_FUNDING: readonly FundingStep[] = [
  { source: "byok", enabled: true },
  { source: "subscription", enabled: true },
  { source: "balance", enabled: true },
];

/** The calls the gateway makes on a model's behalf, set per key. */
export const KeyTools = Schema.Struct({
  /** Models without hosted search get a `web_search` tool the gateway answers. */
  webSearch: Schema.Boolean,
  /** The Gemini model that answers those searches; they are priced at its tariff. */
  searchModel: Schema.String,
  /** How hard the search model thinks; one of the model's `searchEfforts`. */
  searchEffort: Schema.Literals(SEARCH_EFFORTS),
  /** Stream text as the model writes it instead of holding it until the search decision. */
  streamLive: Schema.Boolean,
  /**
   * Models with their own search also get the gateway's `web_search` in its place. Codex's native
   * Responses turns keep OpenAI's hosted search.
   */
  replaceNativeSearch: Schema.Boolean,
  /** Text-only models get a description of each image in place of the image. */
  vision: Schema.Boolean,
});
export type KeyTools = typeof KeyTools.Type;

export const DEFAULT_KEY_TOOLS: KeyTools = {
  webSearch: true,
  searchModel: SEARCH_MODEL_ID,
  searchEffort: DEFAULT_SEARCH_EFFORT,
  streamLive: false,
  replaceNativeSearch: false,
  vision: true,
};

/** A key's stored tools as they apply now, with the search model resolved by {@link searchTarget}. */
export const keyTools = (stored: Partial<KeyTools>): KeyTools => {
  const tools = { ...DEFAULT_KEY_TOOLS, ...stored };
  const target = searchTarget(tools.searchModel, tools.searchEffort);
  return { ...tools, searchModel: target.model.id, searchEffort: target.effort };
};

/** How far smart routing may push reasoning: a cap on the effort it picks from a target's ladder. */
export const ROUTING_CEILINGS = ["low", "medium", "high", "max"] as const;
export type RoutingCeiling = (typeof ROUTING_CEILINGS)[number];

/** Smart routing for one key. Saved with the key; the gateway doesn't serve `jev-auto` yet. */
export const KeyRouting = Schema.Struct({
  /** Opt-in: while off, `jev-auto` is not offered to this key. */
  enabled: Schema.Boolean,
  /** The complete allowlist of catalog model ids, in order. The first one is the fail-open target. */
  targets: Schema.Array(Schema.String),
  ceiling: Schema.Literals(ROUTING_CEILINGS),
});
export type KeyRouting = typeof KeyRouting.Type;

export const DEFAULT_KEY_ROUTING: KeyRouting = {
  enabled: false,
  targets: ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna"],
  ceiling: "max",
};

const KNOWN_MODELS = new Set(CATALOG.map((model) => model.id));

/** A key's stored routing with targets the catalog no longer lists left out. */
export const keyRouting = (stored: Partial<KeyRouting>): KeyRouting => {
  const routing = { ...DEFAULT_KEY_ROUTING, ...stored };
  return { ...routing, targets: routing.targets.filter((id) => KNOWN_MODELS.has(id)) };
};

/** Every key starts `sk-imp-`; the rest is random. */
export const API_KEY_PREFIX = "sk-imp-";

/** The input was refused for a reason a person can fix; `message` says which. */
export class BillingActionFailed extends Schema.TaggedError<BillingActionFailed>()("BillingActionFailed", {
  message: Schema.String,
}) {}

const BillingErrors = Schema.Union([Forbidden, NotFound, BillingActionFailed]);

export class ApiKey extends Schema.Class<ApiKey>("@impact-llm/schemas/ApiKey")({
  id: Schema.String,
  name: Schema.String,
  /** Last four characters of the secret. */
  suffix: Schema.String,
  canCopy: Schema.Boolean,
  /** USD micros per calendar month taken from the balance; null is uncapped. */
  monthlyLimitMicros: Schema.NullOr(Micros),
  funding: Schema.Array(FundingStep),
  tools: KeyTools,
  routing: KeyRouting,
  createdAt: Instant,
  lastUsedAt: Schema.NullOr(Instant),
  requests30d: Schema.Int,
  /** What the key took from the balance over the last 30 days. */
  charged30dMicros: Micros,
  /** What it took this calendar month, against `monthlyLimitMicros`. */
  chargedThisMonthMicros: Micros,
}) {}

export class CreatedApiKey extends Schema.Class<CreatedApiKey>("@impact-llm/schemas/CreatedApiKey")({
  key: ApiKey,
  /** Also available to the owner through ApiKeysGetSecret. */
  secret: Schema.Redacted(Schema.String),
}) {}

export const RequestEndpoint = Schema.Literals(["chat", "responses", "messages", "search"]);
export type RequestEndpoint = typeof RequestEndpoint.Type;

export const RequestStatus = Schema.Literals(["pending", "success", "error", "cancelled"]);
export type RequestStatus = typeof RequestStatus.Type;

const keyLimit = Schema.NullOr(Micros);

/** Writes, and the key secret only the server can decrypt. Keys, logs and the balance are read through Zero. */
export const BillingRpcs = [
  Rpc.make("ApiKeysCreate", {
    payload: {
      name: Schema.String,
      monthlyLimitMicros: keyLimit,
      funding: Schema.Array(FundingStep),
      /** Left out, the key starts with the defaults. */
      tools: Schema.optional(KeyTools),
      routing: Schema.optional(KeyRouting),
    },
    success: CreatedApiKey,
    error: BillingErrors,
  }),
  Rpc.make("ApiKeysUpdate", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      monthlyLimitMicros: Schema.optional(keyLimit),
      funding: Schema.optional(Schema.Array(FundingStep)),
      tools: Schema.optional(KeyTools),
      routing: Schema.optional(KeyRouting),
    },
    success: ApiKey,
    error: BillingErrors,
  }),
  Rpc.make("ApiKeysGetSecret", {
    payload: { id: Schema.String },
    success: Schema.Redacted(Schema.String),
    error: BillingErrors,
  }),
  Rpc.make("ApiKeysRevoke", { payload: { id: Schema.String }, success: Schema.Void, error: BillingErrors }),
] as const;

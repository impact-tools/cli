import { Schema } from "effect";
import { Rpc } from "effect/rpc";

import { Forbidden, NotFound } from "./Errors.ts";
import { SEARCH_EFFORTS } from "./ModelVocabulary.ts";

/** Instants are Unix ms; money is micro-USD integers throughout. */
const Instant = Schema.Finite;
const Micros = Schema.Int;

/** What can pay for a request: your own accounts, the plan's credits, or the balance. */
export const FundingSource = Schema.Literals(["byok", "subscription", "balance"]);
export type FundingSource = typeof FundingSource.Type;

/** Who pays a request Impact serves: the plan's credits (`subscription`) or the balance. */
export type Pot = Exclude<FundingSource, "byok">;

/** Whether Impact serves and charges the source's requests, as against the user's own accounts. */
export const impactPaid = (source: FundingSource): source is Pot => source !== "byok";

/** One step of a key's billing order; disabled steps keep their place. */
export const FundingStep = Schema.Struct({ source: FundingSource, enabled: Schema.Boolean });
export type FundingStep = typeof FundingStep.Type;

export const DEFAULT_FUNDING: readonly FundingStep[] = [
  { source: "byok", enabled: true },
  { source: "subscription", enabled: true },
  { source: "balance", enabled: true },
];

/** The pots a key's enabled steps pay from, in its billing order. */
export const paidPots = (funding: readonly FundingStep[]): Pot[] =>
  funding.flatMap((step) => (step.enabled && impactPaid(step.source) ? [step.source] : []));

/**
 * Whether what is left of plan credits too small for a request spills to the balance: only when the
 * key's balance step comes after its plan-credits step and is on.
 */
export const spillsToBalance = (funding: readonly FundingStep[]): boolean => {
  const credits = funding.findIndex((step) => step.source === "subscription");
  const balance = funding.findIndex((step) => step.source === "balance");
  return credits >= 0 && balance > credits && funding[balance]!.enabled;
};

/**
 * The pots Impact may pay a request from when the key's billing order reaches `source`: the run of
 * enabled plan-credits and balance steps it starts or is in, in the key's order; none for the user's
 * own accounts. Two such steps next to each other are one walk of the operator's pool.
 */
export const groupPots = (funding: readonly FundingStep[], source: FundingSource): Pot[] => {
  if (!impactPaid(source)) return [];
  const enabled = funding.filter((step) => step.enabled);
  const at = enabled.findIndex((step) => step.source === source);
  if (at < 0) return [source];
  let start = at;
  while (start > 0 && impactPaid(enabled[start - 1]!.source)) start -= 1;
  const pots: Pot[] = [];
  for (let index = start; index < enabled.length; index += 1) {
    const candidate = enabled[index]!.source;
    if (!impactPaid(candidate)) break;
    pots.push(candidate);
  }
  return pots;
};

/** Whether the key still pays the way `source` does: an enabled step of the same kind, Impact's or the user's own. */
export const fundingGroupActive = (funding: readonly FundingStep[], source: FundingSource): boolean =>
  funding.some((step) => step.enabled && impactPaid(step.source) === impactPaid(source));

/** The calls the gateway makes on a model's behalf, set per key. */
export const KeyTools = Schema.Struct({
  /** Models without hosted search get a `web_search` tool the gateway answers. */
  webSearch: Schema.Boolean,
  /** The Gemini model that answers those searches; they are charged at its prices on Models. */
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

/** How far smart routing could push reasoning: a cap on the effort it picked from a target's ladder. */
const ROUTING_CEILINGS = ["low", "medium", "high", "max"] as const;
export type RoutingCeiling = (typeof ROUTING_CEILINGS)[number];

/**
 * Retired: smart routing for one key, which account presets (`auto`, `preset/<slug>`) replaced. Kept
 * so CLI 0.5.0 and older and SDK 0.2.0, which require it on a key, can still decode one; the server
 * always sends it switched off.
 */
export const KeyRouting = Schema.Struct({
  enabled: Schema.Boolean,
  targets: Schema.Array(Schema.String),
  ceiling: Schema.Literals(ROUTING_CEILINGS),
});
export type KeyRouting = typeof KeyRouting.Type;

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
  /** Retired, always switched off; see {@link KeyRouting}. Optional so a later server may stop sending it. */
  routing: Schema.optional(KeyRouting),
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

/** The API a request came in on, as its log row records it; `gemini` is Google's Gemini API. */
export const RequestEndpoint = Schema.Literals([
  "chat",
  "responses",
  "messages",
  "search",
  "images",
  "videos",
  "embeddings",
  "gemini",
]);
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

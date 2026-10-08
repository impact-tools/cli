import { Schema } from "effect";
import { Rpc } from "effect/rpc";

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

export class ToolsSettings extends Schema.Class<ToolsSettings>("@impact-llm/schemas/ToolsSettings")({
  /** Models without hosted search get a `web_search` tool the gateway answers. */
  webSearch: Schema.Boolean,
  /** Stream text as the model writes it instead of holding it until the search decision. */
  streamLive: Schema.Boolean,
  /**
   * Models with their own search also get the gateway's `web_search` in its place. Codex's native
   * Responses turns keep OpenAI's hosted search.
   */
  replaceNativeSearch: Schema.Boolean,
  /** Text-only models get a description of each image in place of the image. */
  vision: Schema.Boolean,
}) {}

const keyLimit = Schema.NullOr(Micros);

/** Writes, and the key secret only the server can decrypt. Keys, logs, the balance and tools are read through Zero. */
export const BillingRpcs = [
  Rpc.make("ApiKeysCreate", {
    payload: { name: Schema.String, monthlyLimitMicros: keyLimit, funding: Schema.Array(FundingStep) },
    success: CreatedApiKey,
    error: BillingErrors,
  }),
  Rpc.make("ApiKeysUpdate", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      monthlyLimitMicros: Schema.optional(keyLimit),
      funding: Schema.optional(Schema.Array(FundingStep)),
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
  Rpc.make("ToolsUpdate", {
    payload: {
      webSearch: Schema.optional(Schema.Boolean),
      streamLive: Schema.optional(Schema.Boolean),
      replaceNativeSearch: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    },
    success: ToolsSettings,
    error: BillingErrors,
  }),
] as const;

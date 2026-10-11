import { Schema } from "effect";

/**
 * The `/v1` documents the CLI reads: the wallet and quota, the model lists in their OpenAI and
 * Anthropic shapes, and Codex's model catalog. The server builds each one against its encoded
 * type; the CLI keeps a byte-for-byte copy of this file and decodes with it.
 */

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// ---------------------------------------------------------------------------------------------
// GET /v1/usage and /api/codex/usage

export const UsageAccount = Schema.Struct({ id: Schema.String, email: Schema.String });

/** Amounts are decimal USD strings. `balance` is what is available now: `total` minus `reserved`. */
export const UsageCredits = Schema.Struct({
  has_credits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.String,
  reserved: Schema.String,
  total: Schema.String,
});

/** A key's monthly limit, as Codex reads a usage window. */
export const UsageWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Count,
  /** Unix seconds. */
  reset_at: Count,
});

/** The wallet in the shape Codex reads a ChatGPT plan's usage. */
export const V1Usage = Schema.Struct({
  currency: Schema.Literal("USD"),
  account: UsageAccount,
  plan_type: Schema.String,
  credits: UsageCredits,
  rate_limit: Schema.Struct({
    allowed: Schema.Boolean,
    limit_reached: Schema.Boolean,
    primary_window: Schema.NullOr(UsageWindow),
    secondary_window: Schema.Null,
  }),
  rate_limit_name: Schema.String,
});
export type V1Usage = typeof V1Usage.Type;

/**
 * What a status line reads of the usage document: whose wallet and how much is in it. Servers
 * before the account and the wallet total sent only the available balance, so those stay optional.
 */
export const UsageWallet = Schema.Struct({
  currency: V1Usage.fields.currency,
  account: Schema.optional(UsageAccount),
  credits: Schema.Struct({
    balance: UsageCredits.fields.balance,
    reserved: Schema.optional(UsageCredits.fields.reserved),
    total: Schema.optional(UsageCredits.fields.total),
  }),
});
export type UsageWallet = typeof UsageWallet.Type;

// ---------------------------------------------------------------------------------------------
// GET /v1/models

export const ModelListPricing = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cached_input: Schema.Finite,
  cache_write: Schema.Finite,
  cache_write_1h: Schema.optional(Schema.Finite),
  unit: Schema.Literal("usd_per_1m_tokens"),
});

/** A row of the OpenAI-shaped list. `owned_by` is the model's brand. */
export const OpenAiModel = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("model"),
  created: Count,
  owned_by: Schema.String,
  context_length: Count,
  max_output_tokens: Count,
  capabilities: Schema.Array(Schema.String),
  reasoning_efforts: Schema.Array(Schema.String),
  pricing: ModelListPricing,
});

export const OpenAiModelList = Schema.Struct({ object: Schema.Literal("list"), data: Schema.Array(OpenAiModel) });
export type OpenAiModelList = typeof OpenAiModelList.Type;

/** What a key check reads of the OpenAI-shaped list: the ids it may use. */
export const ModelIdList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: OpenAiModel.fields.id })) });

const Support = Schema.Struct({ supported: Schema.Boolean });

/** Anthropic's ModelInfo, as Claude Code and Claude Desktop read it. */
export const AnthropicModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.String,
  description: Schema.String,
  type: Schema.Literal("model"),
  created_at: Schema.String,
  max_input_tokens: Count,
  max_tokens: Count,
  capabilities: Schema.Struct({
    batch: Support,
    citations: Support,
    code_execution: Support,
    context_management: Schema.Struct({
      supported: Schema.Boolean,
      clear_thinking_20251015: Schema.Null,
      clear_tool_uses_20250919: Schema.Null,
      compact_20260112: Schema.Null,
    }),
    effort: Schema.Struct({
      supported: Schema.Boolean,
      low: Support,
      medium: Support,
      high: Support,
      max: Support,
      xhigh: Schema.NullOr(Support),
    }),
    image_input: Support,
    pdf_input: Support,
    structured_outputs: Support,
    thinking: Schema.Struct({
      supported: Schema.Boolean,
      types: Schema.Struct({ adaptive: Support, enabled: Support }),
    }),
  }),
});

export const AnthropicModelList = Schema.Struct({ data: Schema.Array(AnthropicModel) });
export type AnthropicModelList = typeof AnthropicModelList.Type;

// ---------------------------------------------------------------------------------------------
// GET /v1/models?client_version=… and /backend-api/codex/models?client_version=…

const CodexSpeed = {
  default_service_tier: Schema.Null,
  additional_speed_tiers: Schema.Array(Schema.String),
  service_tiers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String })),
};

/** The fields Codex's model loader accepts, for a model Impact describes itself. */
export const CodexCatalogModel = Schema.Struct({
  ...CodexSpeed,
  slug: Schema.String,
  display_name: Schema.String,
  description: Schema.String,
  priority: Count,
  visibility: Schema.Literal("list"),
  supported_in_api: Schema.Literal(true),
  shell_type: Schema.Literal("unified_exec"),
  tool_mode: Schema.Literals(["direct", "code_mode_only"]),
  base_instructions: Schema.String,
  context_window: Count,
  max_context_window: Count,
  auto_compact_token_limit: Count,
  effective_context_window_percent: Schema.Literal(95),
  comp_hash: Schema.Null,
  input_modalities: Schema.Array(Schema.Literals(["text", "image", "audio"])),
  supported_reasoning_levels: Schema.Array(Schema.Struct({ effort: Schema.String, description: Schema.String })),
  default_reasoning_level: Schema.optional(Schema.String),
  supports_reasoning_summaries: Schema.Boolean,
  default_reasoning_summary: Schema.Literal("none"),
  support_verbosity: Schema.Literal(true),
  default_verbosity: Schema.Literal("low"),
  apply_patch_tool_type: Schema.Literal("freeform"),
  truncation_policy: Schema.Struct({ mode: Schema.Literal("tokens"), limit: Count }),
  supports_parallel_tool_calls: Schema.Literal(true),
  supports_image_detail_original: Schema.Boolean,
  experimental_supported_tools: Schema.Array(Schema.String),
  node_repl_disabled: Schema.Boolean,
  node_repl_auto_review_required: Schema.Boolean,
  include_apps_usage_instructions: Schema.Boolean,
  include_plugin_usage_instructions: Schema.Boolean,
});

/** ChatGPT's own row for an OpenAI model, kept whole under Impact's id, name and order. */
export const CodexNativeModel = Schema.StructWithRest(
  Schema.Struct({
    ...CodexSpeed,
    slug: Schema.String,
    display_name: Schema.String,
    priority: Count,
    visibility: Schema.Literal("list"),
    supported_in_api: Schema.Literal(true),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const CodexModelCatalog = Schema.Struct({
  models: Schema.Array(Schema.Union([CodexCatalogModel, CodexNativeModel])),
});
export type CodexModelCatalog = typeof CodexModelCatalog.Type;

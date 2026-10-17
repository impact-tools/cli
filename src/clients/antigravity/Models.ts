import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { Connection } from "../../config/Connection.ts";
import { impactJson } from "../cursor/Account.ts";
import { ProtocolError } from "../cursor/Impact.ts";

const Model = Schema.Struct({
  id: Schema.String, display_name: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.Int), max_output_tokens: Schema.optional(Schema.Int),
  max_input_tokens: Schema.optional(Schema.Int), max_tokens: Schema.optional(Schema.Int),
  reasoning_efforts: Schema.optional(Schema.Array(Schema.String)),
  capabilities: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Struct({
    supports_vision: Schema.optional(Schema.Boolean),
    image_input: Schema.optional(Schema.Struct({ supported: Schema.Boolean })),
  })])),
});
const decode = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Model) }));
export type GatewayModel = typeof Model.Type & { readonly key: number; readonly label: string };

export function supportsImages(model: GatewayModel): boolean {
  const capabilities = model.capabilities;
  if (!capabilities) return false;
  if (Array.isArray(capabilities)) return capabilities.some(cap => cap === "vision" || cap === "image");
  return ("supports_vision" in capabilities && capabilities.supports_vision === true) ||
    ("image_input" in capabilities && capabilities.image_input?.supported === true);
}

export async function loadModels(connection: Connection): Promise<GatewayModel[]> {
  const catalog = decode(await impactJson(connection, "/v1/models?flavor=anthropic", AbortSignal.timeout(20_000))).data;
  if (!catalog.length) throw new ProtocolError("failed_precondition", "Impact has no enabled models.");
  const keys = new Set<number>();
  return catalog.map(model => {
    // Stable numeric protocol keys retain selection after catalog reordering and restarts.
    let key = 100_000 + createHash("sha256").update(model.id).digest().readUInt32BE(0) % 1_000_000_000;
    while (keys.has(key)) key++;
    keys.add(key);
    return { ...model, key, label: model.display_name || model.id };
  });
}

export function nativeModel(model: GatewayModel) {
  return {
    modelId: model.key, modelName: model.id, chatModelName: model.id, displayName: model.label,
    maxTokens: model.context_length ?? model.max_input_tokens ?? 128_000,
    maxOutputTokens: model.max_output_tokens ?? model.max_tokens ?? 8192,
    apiProvider: "API_PROVIDER_GOOGLE_GEMINI", toolFormatterType: "TOOL_FORMATTER_TYPE_NONE",
  };
}

export function nativeCatalog(models: readonly GatewayModel[], selected: GatewayModel) {
  return {
    clientModelConfigs: models.map(model => ({
      label: model.label, modelOrAlias: { model: model.key }, modelId: model.id,
      supportsImages: supportsImages(model),
    })),
    clientModelSorts: [{ name: "Recommended", groups: [{ groupName: "Impact", modelLabels: models.map(model => model.label) }] }],
    defaultOverrideModelConfig: { modelOrAlias: { model: selected.key }, versionId: `impact:${selected.id}` },
  };
}

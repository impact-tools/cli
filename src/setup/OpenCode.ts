import { MODEL_EFFORTS } from "../schemas/ModelVocabulary.ts";
import { hasTools, hasVision, reasons, SMALL_MODEL, type SetupModel } from "./Models.ts";
import { exportLines } from "./Shell.ts";
import {
  cliSteps,
  codeStep,
  commandStep,
  fieldsStep,
  jsonCode,
  openAiUrl,
  startModel,
  type SetupOptions,
  type SetupStep,
} from "./Steps.ts";

/** OpenCode adds its own efforts to reasoning models; Kilo doesn't. Both drop disabled variants. */
const variants = (efforts: readonly string[]) => ({
  ...Object.fromEntries(MODEL_EFFORTS.map((effort) => [effort, { disabled: true }])),
  ...Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
});

/** A model definition in the provider format OpenCode and its fork Kilo share. */
export function openCodeModel(model: SetupModel) {
  const reasoning = reasons(model);
  const vision = hasVision(model);
  return {
    id: model.id,
    name: model.name,
    tool_call: hasTools(model),
    reasoning,
    variants: variants(model.efforts),
    attachment: vision,
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    ...(reasoning ? { interleaved: { field: "reasoning_content" } } : {}),
    limit: { context: model.contextTokens, output: model.maxOutputTokens },
    ...(model.pricing === undefined
      ? {}
      : {
          cost: {
            input: model.pricing.input,
            output: model.pricing.output,
            cache_read: model.pricing.cachedInput,
            cache_write: model.pricing.cacheWrite,
          },
        }),
  };
}

/** The `impact` provider: Impact's OpenAI-compatible endpoint, the key from `IMPACT_API_KEY`, and `models`. */
export const openCodeProvider = (models: readonly SetupModel[], baseUrl: string) => ({
  name: "Impact",
  npm: "@ai-sdk/openai-compatible",
  env: ["IMPACT_API_KEY"],
  options: { baseURL: baseUrl, apiKey: "{env:IMPACT_API_KEY}" },
  models: Object.fromEntries(models.map((model) => [model.id, openCodeModel(model)])),
});

/** The model titles and summaries use: the small one if it is listed, else the selected one. */
export const openCodeSmallModel = (models: readonly Pick<SetupModel, "id">[], selected: string) =>
  models.some((model) => model.id === SMALL_MODEL) ? SMALL_MODEL : selected;

/** `opencode.json` with Impact as a provider, starting on the launcher's default model. */
export function openCodeConfig(options: SetupOptions) {
  const model = startModel(options).id;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: { impact: openCodeProvider(options.models, openAiUrl(options)) },
    model: `impact/${model}`,
    small_model: `impact/${openCodeSmallModel(options.models, model)}`,
  };
}

const launch = (command: string, options: SetupOptions) =>
  commandStep("launch", options.platform, [`impact ${command}`]);

export const openCodeCliSteps = (options: SetupOptions): SetupStep[] => [
  commandStep("install-client", options.platform, ["npm install --global opencode-ai"]),
  ...cliSteps(options),
  launch("opencode", options),
];

export const openCodeManualSteps = (options: SetupOptions): SetupStep[] => [
  codeStep("settings", "json", jsonCode(openCodeConfig(options)), "opencode.json"),
  commandStep("key", options.platform, [
    ...exportLines(options.platform, { IMPACT_API_KEY: options.apiKey }),
    "opencode",
  ]),
];

export const kiloCliSteps = (options: SetupOptions): SetupStep[] => [
  commandStep("install-client", options.platform, ["npm install --global @kilocode/cli"]),
  ...cliSteps(options),
  launch("kilo", options),
];

/** The Kilo Code extension's custom provider form. */
export const kiloManualSteps = (options: SetupOptions): SetupStep[] => [
  fieldsStep([
    { label: "Provider ID", value: "impact" },
    { label: "Display name", value: "Impact" },
    { label: "Provider API", value: "OpenAI Compatible" },
    { label: "Base URL", value: openAiUrl(options) },
    { label: "API key", value: options.apiKey },
    { label: "Models", value: startModel(options).id },
  ]),
];

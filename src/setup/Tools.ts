import { hasTools, hasVision, reasons, type SetupModel } from "./Models.ts";
import { continued, exportLines, homeFile, quote } from "./Shell.ts";
import {
  anthropicUrl,
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

/** A YAML scalar: plain when it reads back as the same string, else JSON-quoted (valid YAML). */
const yaml = (value: string) => (/^[A-Za-z][\w.-]*$/.test(value) ? value : JSON.stringify(value));

/** The models with the start model first, where a client starts on the first. */
const startFirst = (options: SetupOptions) => {
  const first = startModel(options);
  return [first, ...options.models.filter((model) => model.id !== first.id)];
};

export const cursorCliSteps = (options: SetupOptions): SetupStep[] => [
  ...cliSteps(options, true),
  commandStep("launch", options.platform, ["impact cursor ."]),
];

/** Cursor Settings → Models → API Keys: chat and agent only, called from Cursor's servers. */
export const cursorManualSteps = (options: SetupOptions): SetupStep[] => [
  fieldsStep([
    { label: "OpenAI API Key", value: options.apiKey },
    { label: "Override OpenAI Base URL", value: openAiUrl(options) },
    { label: "Add model", value: startModel(options).id },
  ]),
];

export const antigravityCliSteps = (options: SetupOptions): SetupStep[] => [
  ...cliSteps(options, true),
  commandStep("launch", options.platform, ["impact antigravity"]),
];

/** Cline's and Roo Code's OpenAI Compatible provider. */
const openAiCompatibleFields = (options: SetupOptions, model: string): SetupStep[] => [
  fieldsStep([
    { label: "API Provider", value: "OpenAI Compatible" },
    { label: "Base URL", value: openAiUrl(options) },
    { label: "API Key", value: options.apiKey },
    { label: model, value: startModel(options).id },
  ]),
];

export const clineSteps = (options: SetupOptions) => openAiCompatibleFields(options, "Model ID");

export const rooCodeSteps = (options: SetupOptions) => openAiCompatibleFields(options, "Model");

const continueModel = (model: SetupModel, options: SetupOptions) => [
  `  - name: ${yaml(model.name)}`,
  "    provider: openai",
  `    model: ${yaml(model.id)}`,
  `    apiBase: ${openAiUrl(options)}`,
  "    apiKey: ${{ secrets.IMPACT_API_KEY }}",
  "    roles: [chat, edit, apply]",
  `    capabilities: [${[...(hasTools(model) ? ["tool_use"] : []), ...(hasVision(model) ? ["image_input"] : [])].join(", ")}]`,
  "    defaultCompletionOptions:",
  `      contextLength: ${model.contextTokens}`,
];

/** `~/.continue/config.yaml` with a model entry per listed model, the selected one first; and the key in `.env`. */
export const continueSteps = (options: SetupOptions): SetupStep[] => [
  codeStep(
    "settings",
    "yaml",
    [
      "name: Impact",
      "version: 1.0.0",
      "schema: v1",
      "models:",
      ...startFirst(options).flatMap((model) => continueModel(model, options)),
    ],
    homeFile(options.platform, ".continue", "config.yaml"),
  ),
  codeStep("env-file", "dotenv", `IMPACT_API_KEY=${options.apiKey}`, homeFile(options.platform, ".continue", ".env")),
];

/** Zed's `settings.json`: an OpenAI-compatible provider whose id `impact` makes Zed read `IMPACT_API_KEY`. */
export const zedSettings = (options: SetupOptions) => ({
  language_models: {
    openai_compatible: {
      impact: {
        api_url: openAiUrl(options),
        available_models: options.models.map((model) => ({
          name: model.id,
          display_name: model.name,
          max_tokens: model.contextTokens,
          max_output_tokens: model.maxOutputTokens,
          capabilities: {
            tools: hasTools(model),
            images: hasVision(model),
            parallel_tool_calls: false,
            prompt_cache_key: false,
            chat_completions: true,
            interleaved_reasoning: reasons(model),
            max_tokens_parameter: false,
          },
        })),
      },
    },
  },
});

export const zedSteps = (options: SetupOptions): SetupStep[] => [
  codeStep("settings", "json", jsonCode(zedSettings(options)), "settings.json"),
  commandStep("key", options.platform, exportLines(options.platform, { IMPACT_API_KEY: options.apiKey })),
];

export const aiderSteps = (options: SetupOptions): SetupStep[] => [
  commandStep("run", options.platform, [
    ...exportLines(options.platform, { OPENAI_API_BASE: openAiUrl(options), OPENAI_API_KEY: options.apiKey }),
    "",
    `aider --model openai/${startModel(options).id}`,
  ]),
  codeStep(
    "settings",
    "yaml",
    [`openai-api-base: ${openAiUrl(options)}`, `model: ${yaml(`openai/${startModel(options).id}`)}`],
    ".aider.conf.yml",
  ),
];

export const openWebUiSteps = (options: SetupOptions): SetupStep[] => [
  commandStep("docker", options.platform, [
    continued(options.platform, [
      "docker run -d -p 3000:8080",
      `-e OPENAI_API_BASE_URL=${openAiUrl(options)}`,
      `-e OPENAI_API_KEY=${quote(options.platform, options.apiKey)}`,
      "-v open-webui:/app/backend/data",
      "--name open-webui ghcr.io/open-webui/open-webui:main",
    ]),
  ]),
  fieldsStep([
    { label: "URL", value: openAiUrl(options) },
    { label: "API Key", value: options.apiKey },
  ]),
];

/** A custom endpoint in `librechat.yaml`; `default` is the list LibreChat shows if fetching the models fails. */
export const libreChatSteps = (options: SetupOptions): SetupStep[] => [
  codeStep(
    "settings",
    "yaml",
    [
      "endpoints:",
      "  custom:",
      `    - name: "Impact Relay"`,
      `      apiKey: "\${IMPACT_API_KEY}"`,
      `      baseURL: "${openAiUrl(options)}"`,
      "      models:",
      `        default: [${startFirst(options)
        .map((model) => JSON.stringify(model.id))
        .join(", ")}]`,
      "        fetch: true",
    ],
    "librechat.yaml",
  ),
  codeStep("env-file", "dotenv", `IMPACT_API_KEY=${options.apiKey}`, ".env"),
];

/** Any tool with an OpenAI- or Anthropic-compatible provider. */
export const otherSteps = (options: SetupOptions): SetupStep[] => [
  fieldsStep([
    { label: "Base URL (OpenAI)", value: openAiUrl(options), term: "openai-url" },
    { label: "Base URL (Anthropic)", value: anthropicUrl(options), term: "anthropic-url" },
    { label: "API key", value: options.apiKey, term: "api-key" },
    { label: "Model", value: startModel(options).id, term: "model" },
  ]),
];

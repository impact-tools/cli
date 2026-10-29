import { continued, exportLines, homeFile } from "./Shell.ts";
import { cliSteps, codeStep, commandStep, openAiUrl, startModel, type SetupOptions, type SetupStep } from "./Steps.ts";

/** A TOML basic string: JSON's escapes are TOML's for the URLs and ids written here. */
const toml = (value: string) => JSON.stringify(value);

/** `~/.codex/config.toml` with Impact as its provider. The two top-level keys go before the first table. */
export const codexConfig = (options: SetupOptions) =>
  [
    `model_provider = "impact"`,
    `model = ${toml(startModel(options).id)}`,
    "",
    "[model_providers.impact]",
    `name = "Impact Relay"`,
    `base_url = ${toml(openAiUrl(options))}`,
    `env_key = "IMPACT_API_KEY"`,
    `wire_api = "responses"`,
    "requires_openai_auth = false",
    "supports_websockets = false",
  ].join("\n");

/** Downloads the catalog `/model` lists, for the running Codex version. */
const catalogCommand = (options: SetupOptions) => {
  const url = `${openAiUrl(options)}/models?client_version=`;
  return options.platform === "windows"
    ? [
        `$version = (codex --version).Split(" ")[-1]`,
        continued(options.platform, [
          `Invoke-WebRequest -Headers @{ Authorization = "Bearer $env:IMPACT_API_KEY" }`,
          `-OutFile "$HOME\\.codex\\impact-models.json" "${url}$version"`,
        ]),
      ]
    : [
        continued(options.platform, [
          `curl -fsS -H "Authorization: Bearer $IMPACT_API_KEY" -o ~/.codex/impact-models.json`,
          `"${url}$(codex --version | awk '{print $NF}')"`,
        ]),
      ];
};

export const codexCliSteps = (options: SetupOptions): SetupStep[] => [
  ...cliSteps(options, true),
  commandStep("launch", options.platform, ["impact codex"]),
];

export const codexManualSteps = (options: SetupOptions): SetupStep[] => [
  codeStep("settings", "toml", codexConfig(options), homeFile(options.platform, ".codex", "config.toml")),
  commandStep("key", options.platform, [...exportLines(options.platform, { IMPACT_API_KEY: options.apiKey }), "codex"]),
  commandStep("catalog", options.platform, catalogCommand(options)),
];

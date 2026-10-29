import type { SetupModel } from "./Models.ts";

import { homeFile } from "./Shell.ts";
import { anthropicUrl, cliSteps, codeStep, commandStep, jsonCode, type SetupOptions, type SetupStep } from "./Steps.ts";

/** Claude Code's `/model` menu with Impact's models in place of its own. */
export const claudeModelPicker = (models: readonly Pick<SetupModel, "id" | "name" | "description">[]) => ({
  replaceBuiltInOptions: true,
  options: models.map((model) => ({
    model: model.id,
    label: model.name,
    description: model.description ?? model.name,
  })),
});

/**
 * The compaction window a non-Claude model gets: its own context, within the 100k to 1M range
 * Claude Code accepts for `autoCompactWindow`. Claude models and smaller ones are left to Claude.
 */
export const compactWindow = (model: Pick<SetupModel, "id" | "contextTokens">) =>
  model.id.startsWith("claude-") || model.contextTokens < 100_000
    ? undefined
    : Math.min(model.contextTokens, 1_000_000);

/**
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: the context Claude Code assumes for every model it doesn't know
 * (200k without it), one value for the whole session. A model picked later with `/model` gets it
 * too, so it is the largest window the session may need: the selected model's, or any non-Claude
 * model's. Claude Code compacts within the smaller of it and a model's `autoCompactWindow`, so each
 * smaller model is still held to its own.
 */
export function unknownModelContext(
  models: readonly Pick<SetupModel, "id" | "contextTokens">[],
  selected: Pick<SetupModel, "contextTokens"> | undefined,
) {
  const windows = [selected?.contextTokens || undefined, ...models.map(compactWindow)].filter(
    (window): window is number => window !== undefined,
  );
  return windows.length === 0 ? undefined : Math.max(...windows);
}

/** `~/.claude/settings.json` for Claude Code without the launcher: the key and the `/model` menu. */
export function claudeSettings(options: SetupOptions) {
  const context = unknownModelContext(options.models, undefined);
  const windows = options.models.flatMap((model) => {
    const window = compactWindow(model);
    return window === undefined ? [] : [[model.id, { autoCompactWindow: window }] as const];
  });
  return {
    env: {
      ANTHROPIC_BASE_URL: anthropicUrl(options),
      ANTHROPIC_AUTH_TOKEN: options.apiKey,
      ANTHROPIC_API_KEY: "",
      ...(context === undefined ? {} : { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(context) }),
    },
    modelPicker: claudeModelPicker(options.models),
    ...(windows.length === 0 ? {} : { modelSettings: Object.fromEntries(windows) }),
  };
}

export const claudeCliSteps = (options: SetupOptions): SetupStep[] => [
  ...cliSteps(options),
  commandStep("launch", options.platform, ["impact claude"]),
];

export const claudeManualSteps = (options: SetupOptions): SetupStep[] => [
  codeStep(
    "settings",
    "json",
    jsonCode(claudeSettings(options)),
    homeFile(options.platform, ".claude", "settings.json"),
  ),
];

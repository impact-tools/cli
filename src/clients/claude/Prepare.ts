import { Effect } from "effect";
import { toMerged } from "es-toolkit";

import { helperCommand } from "../../process/Self.ts";
import { clientEnvironment, type LaunchOptions } from "../Client.ts";
import { claudeConfig } from "./Config.ts";
import { claudeModels, modelWindows, selectedModel } from "./Models.ts";
import { prepareStatusLine } from "./StatusLine.ts";

export const prepareClaude = Effect.fn("prepareClaude")(function* ({ args, connection }: LaunchOptions) {
  const env = clientEnvironment(connection);
  const config = yield* claudeConfig(args);
  const catalog = yield* claudeModels(connection);
  const selected = selectedModel(catalog.models, config.model);
  const statusLine = yield* prepareStatusLine(connection, config.statusLine);
  const gatewayEnv = {
    ANTHROPIC_BASE_URL: connection.baseUrl,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    ...(env.IMPACT_MODEL ? { ANTHROPIC_MODEL: env.IMPACT_MODEL } : {}),
    ...(selected?.max_input_tokens && !env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(selected.max_input_tokens) }
      : {}),
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_USE_GATEWAY: "0",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  const settings = toMerged(config.settings, {
    env: gatewayEnv,
    apiKeyHelper: helperCommand("token"),
    modelPicker: catalog.modelPicker,
    modelSettings: modelWindows(catalog.models, config.effective),
    statusLine: statusLine.settings,
  });
  const launchEnv: NodeJS.ProcessEnv = { ...env, ...gatewayEnv, IMPACT_CLAUDE_STATUS_FILE: statusLine.path };
  return {
    env: launchEnv,
    args: ["--settings", JSON.stringify(settings), ...config.args],
  };
});

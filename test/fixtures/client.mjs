#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli 0.160.0");
  process.exit(0);
}
const settingsIndex = args.indexOf("--settings");
const settings = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : undefined;
const cursorBackend = args.find((arg) => arg.startsWith("--test-backend-url="))?.slice("--test-backend-url=".length);
const cursorModels = cursorBackend
  ? await fetch(`${cursorBackend}/v1/models`).then((response) => response.json())
  : undefined;
console.log(
  JSON.stringify({
    args,
    cursorModels,
    cursorIpc: process.env.VSCODE_IPC_HOOK_CLI,
    cwd: process.cwd(),
    kiloConfig: process.env.KILO_CONFIG_CONTENT ? JSON.parse(process.env.KILO_CONFIG_CONTENT) : undefined,
    openCodeConfig: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : undefined,
    codexHome: process.env.CODEX_HOME,
    auth:
      process.env.CODEX_HOME && args.includes("--profile")
        ? JSON.parse(readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8"))
        : undefined,
    profile: args.includes("--profile")
      ? readFileSync(join(process.env.CODEX_HOME, args[args.indexOf("--profile") + 1] + ".config.toml"), "utf8")
      : undefined,
    endpoint: process.env.ANTHROPIC_BASE_URL,
    provider: process.env.CLAUDE_CODE_USE_VERTEX,
    settings,
    statusFile: process.env.IMPACT_CLAUDE_STATUS_FILE,
    models: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name === "ANTHROPIC_MODEL" ||
          name.startsWith("ANTHROPIC_DEFAULT_") ||
          name === "CLAUDE_CODE_SUBAGENT_MODEL" ||
          name === "ANTHROPIC_SMALL_FAST_MODEL",
      ),
    ),
    status:
      settings?.statusLine && process.env.CLIENT_STATUS_INPUT
        ? execSync(settings.statusLine.command, { encoding: "utf8", input: process.env.CLIENT_STATUS_INPUT })
        : undefined,
    helperToken: settings ? execSync(settings.apiKeyHelper, { encoding: "utf8" }).trim() : undefined,
    key: process.env.IMPACT_API_KEY,
    input: process.env.CLIENT_READ_STDIN
      ? await new Promise((resolve) => {
          let text = "";
          process.stdin.on("data", (chunk) => {
            text += chunk;
          });
          process.stdin.on("end", () => resolve(text));
        })
      : undefined,
  }),
);
process.exitCode = Number(process.env.CLIENT_EXIT ?? 0);

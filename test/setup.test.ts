import { assert, describe, it } from "@effect/vitest";
import { parse } from "smol-toml";

import type { SetupModel } from "../src/setup/Models.ts";

import { claudeSettings } from "../src/setup/Claude.ts";
import { openCodeConfig } from "../src/setup/OpenCode.ts";
import { SETUP_TOOL_IDS, setupInputs, setupMethods, setupSteps, type SetupMethod } from "../src/setup/Setup.ts";
import { exportLines, PLATFORMS, quote } from "../src/setup/Shell.ts";
import { KEY_PLACEHOLDER, type SetupOptions, type SetupStep } from "../src/setup/Steps.ts";

const model = (id: string, overrides: Partial<SetupModel> = {}): SetupModel => ({
  id,
  name: id.toUpperCase(),
  contextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: ["reasoning", "vision", "tools"],
  efforts: ["low", "high"],
  pricing: { input: 0.6, output: 3, cachedInput: 0.06, cacheWrite: 0.75 },
  ...overrides,
});

const sonnet = model("claude-sonnet-5-5");
const gpt = model("gpt-6.1-sol", { contextTokens: 500_000 });
const text = model("custom-text", { capabilities: [], efforts: [], contextTokens: 32_000 });
const key = `sk-imp-${"a".repeat(43)}`;

const options = (overrides: Partial<SetupOptions> = {}): SetupOptions => ({
  models: [sonnet, gpt, text],
  apiKey: key,
  platform: "unix",
  ...overrides,
});

const code = (steps: readonly SetupStep[], id: SetupStep["id"]) => {
  const step = steps.find((step) => step.id === id);
  assert.isDefined(step, `no ${id} step`);
  assert.strictEqual(step.kind, "code");
  return step.kind === "code" ? step : (undefined as never);
};

const every = SETUP_TOOL_IDS.flatMap((tool) => setupMethods(tool).map((method) => ({ tool, method })));

describe("setup generator", () => {
  it("gives every tool a method, and the launcher only to the clients impact starts", () => {
    for (const tool of SETUP_TOOL_IDS) assert.isAbove(setupMethods(tool).length, 0, tool);
    assert.deepStrictEqual(
      SETUP_TOOL_IDS.filter((tool) => setupMethods(tool).includes("cli")),
      ["claude-code", "codex", "cursor", "antigravity", "kilo-code", "opencode"],
    );
  });

  it.each(every)(
    "$tool by $method: JSON and TOML that parse, and the key only where it is asked for",
    ({ tool, method }) => {
      for (const platform of PLATFORMS) {
        const steps = setupSteps(tool, method, options({ platform }));
        assert.isAbove(steps.length, 0);
        for (const step of steps) {
          if (step.kind !== "code") continue;
          if (step.language === "json") JSON.parse(step.code);
          if (step.language === "toml") parse(step.code);
          assert.notInclude(step.code, "undefined");
        }
        const json = JSON.stringify(steps);
        assert.strictEqual(json.includes(key), setupInputs(tool, method).apiKey, `${tool} ${method} ${platform}`);
      }
    },
  );

  it("asks for the platform and the key only where they change the steps", () => {
    assert.deepStrictEqual(setupInputs("claude-code", "cli"), { platform: true, apiKey: false });
    assert.deepStrictEqual(setupInputs("claude-code", "manual"), { platform: true, apiKey: true });
    assert.deepStrictEqual(setupInputs("cline", "manual"), { platform: false, apiKey: true });
    assert.isTrue(setupInputs("open-webui", "manual").platform);
    assert.isFalse(setupInputs("librechat", "manual").platform);
  });

  it("starts a client that needs one model on the launcher's default, and lists every model elsewhere", () => {
    const fields = setupSteps("cline", "manual", options()).find((step) => step.kind === "fields");
    assert.deepInclude(fields?.kind === "fields" ? fields.fields : [], { label: "Model ID", value: "gpt-6.1-sol" });
    assert.include(code(setupSteps("aider", "manual", options()), "run").code, "aider --model openai/gpt-6.1-sol");
    assert.include(
      code(setupSteps("aider", "manual", options({ models: [sonnet] })), "run").code,
      "openai/claude-sonnet-5-5",
    );
  });

  it("returns no steps for a method the tool lacks", () => {
    assert.deepStrictEqual(setupSteps("antigravity", "manual" as SetupMethod, options()), []);
    assert.deepStrictEqual(setupSteps("zed", "cli", options()), []);
  });
});

describe("shell syntax", () => {
  it("sets variables in a POSIX shell and in PowerShell", () => {
    assert.deepStrictEqual(exportLines("unix", { IMPACT_API_KEY: KEY_PLACEHOLDER }), [
      'export IMPACT_API_KEY="sk-imp-…"',
    ]);
    assert.deepStrictEqual(exportLines("windows", { IMPACT_API_KEY: KEY_PLACEHOLDER }), [
      '$env:IMPACT_API_KEY = "sk-imp-…"',
    ]);
  });

  it("escapes what each shell would expand inside double quotes", () => {
    assert.strictEqual(quote("unix", 'a"$b`c\\'), '"a\\"\\$b\\`c\\\\"');
    assert.strictEqual(quote("windows", 'a"$b`c'), '"a`"`$b``c"');
  });

  it("installs the CLI with the script for the platform", () => {
    assert.strictEqual(
      code(setupSteps("claude-code", "cli", options()), "install-cli").code,
      "curl -fsSL https://impact-relay.com/install.sh | sh",
    );
    const windows = code(setupSteps("claude-code", "cli", options({ platform: "windows" })), "install-cli");
    assert.strictEqual(windows.code, "irm https://impact-relay.com/install.ps1 | iex");
    assert.strictEqual(windows.language, "powershell");
  });
});

describe("Claude Code", () => {
  it("writes the key and Impact's /model menu into settings.json, and leaves the model to /model", () => {
    const settings = claudeSettings(options());
    assert.deepStrictEqual(settings.env, {
      ANTHROPIC_BASE_URL: "https://api.impact-relay.com",
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
    });
    assert.deepStrictEqual(
      settings.modelPicker.options.map((option) => option.model),
      ["claude-sonnet-5-5", "gpt-6.1-sol", "custom-text"],
    );
    // Claude models and ones under 100k are Claude Code's to compact.
    assert.deepStrictEqual(settings.modelSettings, { "gpt-6.1-sol": { autoCompactWindow: 500_000 } });
  });

  it("keeps the file in the home folder of the platform", () => {
    assert.strictEqual(
      code(setupSteps("claude-code", "manual", options()), "settings").path,
      "~/.claude/settings.json",
    );
    assert.strictEqual(
      code(setupSteps("claude-code", "manual", options({ platform: "windows" })), "settings").path,
      "%USERPROFILE%\\.claude\\settings.json",
    );
  });

  it("starts the launcher with no flags", () => {
    assert.strictEqual(code(setupSteps("claude-code", "cli", options()), "launch").code, "impact claude");
  });
});

describe("Codex", () => {
  it("adds Impact as the config.toml provider, the key read from IMPACT_API_KEY", () => {
    const steps = setupSteps("codex", "manual", options());
    assert.deepStrictEqual(parse(code(steps, "settings").code), {
      model_provider: "impact",
      model: "gpt-6.1-sol",
      model_providers: {
        impact: {
          name: "Impact Relay",
          base_url: "https://api.impact-relay.com/v1",
          env_key: "IMPACT_API_KEY",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
        },
      },
    });
    assert.notInclude(code(steps, "settings").code, key);
    assert.strictEqual(code(steps, "key").code, `export IMPACT_API_KEY="${key}"\ncodex`);
  });

  it("sets up and starts the proxy before the launch", () => {
    assert.deepStrictEqual(
      setupSteps("codex", "cli", options()).map((step) => step.id),
      ["install-cli", "sign-in", "proxy", "launch"],
    );
  });
});

describe("OpenCode", () => {
  it("lists every model under the impact provider, with variants, limits and prices", () => {
    const config = openCodeConfig(options());
    assert.strictEqual(config.model, "impact/gpt-6.1-sol");
    assert.strictEqual(config.small_model, "impact/gpt-6.1-sol");
    assert.deepStrictEqual(Object.keys(config.provider.impact.models), [
      "claude-sonnet-5-5",
      "gpt-6.1-sol",
      "custom-text",
    ]);
    assert.strictEqual(config.provider.impact.options.apiKey, "{env:IMPACT_API_KEY}");
    const plain = config.provider.impact.models["custom-text"]!;
    assert.isFalse(plain.reasoning);
    assert.isFalse(plain.attachment);
    assert.notProperty(plain, "interleaved");
  });

  it("keeps titles and summaries on the small model when it is listed", () => {
    const luna = model("gpt-5.6-luna");
    assert.strictEqual(openCodeConfig(options({ models: [sonnet, luna] })).small_model, "impact/gpt-5.6-luna");
  });
});

describe("editors and chat apps", () => {
  it("puts the start model first where a client starts on the first", () => {
    const steps = setupSteps("continue", "manual", options());
    const config = code(steps, "settings").code;
    assert.isBelow(config.indexOf("model: gpt-6.1-sol"), config.indexOf("model: claude-sonnet-5-5"));
    assert.include(config, "capabilities: [tool_use, image_input]");
    assert.include(config, "capabilities: []");
    assert.strictEqual(code(steps, "env-file").code, `IMPACT_API_KEY=${key}`);
    assert.include(
      code(setupSteps("librechat", "manual", options()), "settings").code,
      'default: ["gpt-6.1-sol", "claude-sonnet-5-5", "custom-text"]',
    );
  });

  it("gives Zed each model's context, output and image support", () => {
    const settings = JSON.parse(code(setupSteps("zed", "manual", options()), "settings").code);
    const models = settings.language_models.openai_compatible.impact.available_models;
    assert.deepStrictEqual(models[0], {
      name: "claude-sonnet-5-5",
      display_name: "CLAUDE-SONNET-5-5",
      max_tokens: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: {
        tools: true,
        images: true,
        parallel_tool_calls: false,
        prompt_cache_key: false,
        chat_completions: true,
        interleaved_reasoning: true,
        max_tokens_parameter: false,
      },
    });
    assert.strictEqual(models[2].capabilities.images, false);
    assert.notProperty(settings, "agent");
  });

  it("continues Docker's command the way each shell does", () => {
    assert.include(
      code(setupSteps("open-webui", "manual", options()), "docker").code,
      " \\\n  -e OPENAI_API_BASE_URL=",
    );
    assert.include(
      code(setupSteps("open-webui", "manual", options({ platform: "windows" })), "docker").code,
      " `\n  -e OPENAI_API_BASE_URL=",
    );
  });
});

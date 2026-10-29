import type { SetupModel } from "./Models.ts";
import type { SetupOptions, SetupStep } from "./Steps.ts";

import { claudeCliSteps, claudeManualSteps } from "./Claude.ts";
import { codexCliSteps, codexManualSteps } from "./Codex.ts";
import { kiloCliSteps, kiloManualSteps, openCodeCliSteps, openCodeManualSteps } from "./OpenCode.ts";
import { PLATFORMS } from "./Shell.ts";
import {
  aiderSteps,
  antigravityCliSteps,
  clineSteps,
  continueSteps,
  cursorCliSteps,
  cursorManualSteps,
  libreChatSteps,
  openWebUiSteps,
  otherSteps,
  rooCodeSteps,
  zedSteps,
} from "./Tools.ts";

/** How a tool is set up: started by `impact <client>`, or configured by hand. */
export type SetupMethod = "cli" | "manual";

type Steps = (options: SetupOptions) => SetupStep[];

/**
 * Every tool a setup can be generated for, in the order the docs list them, with the steps of each
 * method it supports. `group` sorts the docs' picker; `label` is the tool's own name.
 */
export const SETUP_TOOLS = {
  "claude-code": { label: "Claude Code", group: "agent", cli: claudeCliSteps, manual: claudeManualSteps },
  codex: { label: "Codex", group: "agent", cli: codexCliSteps, manual: codexManualSteps },
  cursor: { label: "Cursor", group: "agent", cli: cursorCliSteps, manual: cursorManualSteps },
  antigravity: { label: "Antigravity", group: "agent", cli: antigravityCliSteps },
  "kilo-code": { label: "Kilo Code", group: "agent", cli: kiloCliSteps, manual: kiloManualSteps },
  opencode: { label: "OpenCode", group: "agent", cli: openCodeCliSteps, manual: openCodeManualSteps },
  cline: { label: "Cline", group: "editor", manual: clineSteps },
  "roo-code": { label: "Roo Code", group: "editor", manual: rooCodeSteps },
  continue: { label: "Continue", group: "editor", manual: continueSteps },
  zed: { label: "Zed", group: "editor", manual: zedSteps },
  aider: { label: "Aider", group: "editor", manual: aiderSteps },
  "open-webui": { label: "Open WebUI", group: "chat", manual: openWebUiSteps },
  librechat: { label: "LibreChat", group: "chat", manual: libreChatSteps },
  other: { label: "Other", group: "other", manual: otherSteps },
} as const satisfies Record<
  string,
  { label: string; group: "agent" | "editor" | "chat" | "other"; cli?: Steps; manual?: Steps }
>;

export type SetupTool = keyof typeof SETUP_TOOLS;

export const SETUP_TOOL_IDS = Object.keys(SETUP_TOOLS) as SetupTool[];

export const isSetupTool = (id: string): id is SetupTool => Object.hasOwn(SETUP_TOOLS, id);

/** The methods `tool` supports, the launcher first. */
export const setupMethods = (tool: SetupTool): SetupMethod[] => {
  const entry: { readonly cli?: Steps; readonly manual?: Steps } = SETUP_TOOLS[tool];
  return [...(entry.cli ? (["cli"] as const) : []), ...(entry.manual ? (["manual"] as const) : [])];
};

/** The steps that set `tool` up by `method`; none if it has no such method. */
export const setupSteps = (tool: SetupTool, method: SetupMethod, options: SetupOptions): SetupStep[] => {
  const entry: { readonly cli?: Steps; readonly manual?: Steps } = SETUP_TOOLS[tool];
  return entry[method]?.(options) ?? [];
};

const probe = (id: string): SetupModel => ({
  id,
  name: id,
  contextTokens: 400_000,
  maxOutputTokens: 64_000,
  capabilities: ["tools"],
  efforts: [],
});

/** What a reader does with the steps: the text and the files, not how the code is highlighted. */
const reading = (steps: readonly SetupStep[]) =>
  JSON.stringify(steps.map((step) => (step.kind === "code" ? { ...step, language: undefined } : step)));

/**
 * Which choices change what `build` writes: the platform and the key. A page asks only for the
 * ones that matter, so a command that reads the same in every shell asks for no system. Found by
 * generating the steps twice with one choice changed, so it can't fall out of step with the
 * generators.
 */
export function stepInputs(build: (options: SetupOptions) => readonly SetupStep[]) {
  const base: SetupOptions = { models: [probe("model-a")], apiKey: "sk-imp-a", platform: PLATFORMS[0] };
  const same = (changed: Partial<SetupOptions>) => reading(build(base)) === reading(build({ ...base, ...changed }));
  return { platform: !same({ platform: PLATFORMS[1] }), apiKey: !same({ apiKey: "sk-imp-b" }) };
}

/** {@link stepInputs} of `tool` set up by `method`. */
export const setupInputs = (tool: SetupTool, method: SetupMethod) =>
  stepInputs((options) => setupSteps(tool, method, options));

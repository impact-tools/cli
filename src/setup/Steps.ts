import { defaultModel, type SetupModel } from "./Models.ts";
import { shellLanguage, type Platform } from "./Shell.ts";

/** Impact's API origin; the OpenAI-shaped endpoints are under `/v1`, Anthropic clients add it themselves. */
export const API_ORIGIN = "https://api.impact-relay.com";

/** The web app, which serves the CLI's install scripts. */
export const APP_ORIGIN = "https://impact-relay.com";

/** What a key looks like before the reader has one: the docs' placeholder. */
export const KEY_PLACEHOLDER = "sk-imp-…";

/** Everything a setup is generated from. */
export interface SetupOptions {
  /** Impact's models, at least one; a client that takes a list gets them all. */
  readonly models: readonly SetupModel[];
  /** An Impact key, or {@link KEY_PLACEHOLDER}. */
  readonly apiKey: string;
  readonly platform: Platform;
  /** Impact's API origin, {@link API_ORIGIN} unless given. */
  readonly baseUrl?: string | undefined;
}

export type SetupLanguage = "bash" | "powershell" | "json" | "toml" | "yaml" | "dotenv" | "text";

/** What a step is for; the page that shows a setup words each one. */
export type StepId =
  | "install-client"
  | "install-cli"
  | "sign-in"
  | "proxy"
  | "launch"
  | "settings"
  | "env-file"
  | "key"
  | "run"
  | "catalog"
  | "fields"
  | "docker";

/** A field of a client's settings screen; `label` is the client's own wording, untranslated. */
export interface SetupField {
  readonly label: string;
  readonly value: string;
  /** Impact's own name for the value, for a reader whose client has no such screen. */
  readonly term?: "openai-url" | "anthropic-url" | "api-key" | "model" | undefined;
}

/** One thing to do: run or save some code (`path` names the file), or fill in a settings screen. */
export type SetupStep =
  | {
      readonly kind: "code";
      readonly id: StepId;
      readonly language: SetupLanguage;
      readonly code: string;
      readonly path?: string | undefined;
    }
  | { readonly kind: "fields"; readonly id: StepId; readonly fields: readonly SetupField[] };

export const codeStep = (
  id: StepId,
  language: SetupLanguage,
  code: string | readonly string[],
  path?: string,
): SetupStep => ({ kind: "code", id, language, code: typeof code === "string" ? code : code.join("\n"), path });

export const commandStep = (id: StepId, platform: Platform, lines: readonly string[]) =>
  codeStep(id, shellLanguage(platform), lines);

export const fieldsStep = (fields: readonly SetupField[]): SetupStep => ({ kind: "fields", id: "fields", fields });

export const jsonCode = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * The one model a client that needs a single id gets: the launcher's default when Impact offers it.
 * Nobody picks it here; the client's own model menu switches.
 */
export const startModel = (options: Pick<SetupOptions, "models">) => defaultModel(options.models)!;

export const openAiUrl = (options: SetupOptions) => `${options.baseUrl ?? API_ORIGIN}/v1`;

export const anthropicUrl = (options: SetupOptions) => options.baseUrl ?? API_ORIGIN;

/** Installs the `impact` command and signs in; the CLI then creates a key of its own. */
export const cliSteps = ({ platform }: Pick<SetupOptions, "platform">, proxy = false): SetupStep[] => [
  commandStep("install-cli", platform, [
    platform === "windows" ? `irm ${APP_ORIGIN}/install.ps1 | iex` : `curl -fsSL ${APP_ORIGIN}/install.sh | sh`,
  ]),
  commandStep("sign-in", platform, ["impact login"]),
  ...(proxy ? [commandStep("proxy", platform, ["impact proxy setup", "impact proxy start"])] : []),
];

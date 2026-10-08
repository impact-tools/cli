import { Effect, FileSystem } from "effect";
import { flattenObject, toMerged } from "es-toolkit";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

import { CliError, mapPlatformError } from "../../Errors.ts";

export const codexHome = () => resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));

/**
 * Writes a temporary profile: the user's `config.toml` with Impact's settings on top.
 * `overrides` carries the same settings as `-c` flags for commands without `--profile`.
 */
export const configureCodex = Effect.fn("configureCodex")(function* (
  model: string,
  catalog: unknown,
  proxyUrl: string,
  directory = codexHome(),
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const original = yield* fs
    .readFileString(join(directory, "config.toml"))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
  const existing = yield* Effect.try({
    try: () => parse(original),
    catch: () => new CliError({ message: "Your Codex config is invalid TOML. Fix it before running impact codex." }),
  });
  const catalogPath = yield* fs.makeTempFileScoped({ directory, prefix: ".impact-models-", suffix: ".json" });
  yield* fs.writeFileString(catalogPath, JSON.stringify(catalog));
  const impact = {
    model,
    model_provider: "impact",
    model_catalog_json: catalogPath,
    model_providers: {
      impact: {
        name: "Impact",
        base_url: `${proxyUrl}/v1`,
        model_catalog_url: `${proxyUrl}/v1/models`,
        wire_api: "responses",
        requires_openai_auth: true,
        supports_websockets: false,
      },
    },
    chatgpt_base_url: proxyUrl,
    cli_auth_credentials_store: "file",
    sqlite_home: existing.sqlite_home ?? process.env.CODEX_SQLITE_HOME ?? codexHome(),
    features: { fast_mode: true, apps: false },
  };
  const name = `impact-${randomUUID()}`;
  const profilePath = join(directory, `${name}.config.toml`);
  yield* Effect.addFinalizer(() => fs.remove(profilePath, { force: true }).pipe(Effect.ignore));
  yield* fs.writeFileString(profilePath, stringify(toMerged(existing, impact)), { mode: 0o600 });
  const overrides = Object.entries(flattenObject(impact)).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
  return { name, overrides };
}, mapPlatformError("Cannot write the Codex profile"));

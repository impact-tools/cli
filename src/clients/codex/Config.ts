import { Effect, FileSystem } from "effect";
import { toMerged } from "es-toolkit";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

import { CliError, mapPlatformError } from "../../Errors.ts";

export const codexHome = () => resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));

/**
 * Writes the user's `config.toml` with Impact's settings on top: by default as a temporary profile
 * that `--profile <name>` selects. `home` instead replaces `config.toml` itself, for the launch's own
 * Codex home and commands without `--profile` (`app-server`): the proxy URL carries its secret, so
 * it stays in files only the user can read, never in the process arguments.
 */
export const configureCodex = Effect.fn("configureCodex")(function* (
  model: string,
  catalog: unknown,
  proxyUrl: string,
  directory = codexHome(),
  target: "profile" | "home" = "profile",
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
  const merged = stringify(toMerged(existing, impact));
  const name = `impact-${randomUUID()}`;
  if (target === "home") {
    if (resolve(directory) === codexHome())
      return yield* new CliError({ message: "Impact never rewrites your own Codex config." });
    // The rename replaces the link to the user's config.toml, never the file it points at.
    const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".impact-config-", suffix: ".toml" });
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, merged);
    yield* fs.rename(temporary, join(directory, "config.toml"));
    return { name };
  }
  const profilePath = join(directory, `${name}.config.toml`);
  yield* Effect.addFinalizer(() => fs.remove(profilePath, { force: true }).pipe(Effect.ignore));
  yield* fs.writeFileString(profilePath, merged, { mode: 0o600 });
  return { name };
}, mapPlatformError("Cannot write the Codex profile"));

import { Effect, FileSystem } from "effect";
import { flattenObject, toMerged } from "es-toolkit";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { restoreCodexSessionAliases } from "./Sessions.ts";

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
  target: "profile" | "home" = "profile",
  /** Impact's MCP servers at the proxy, merged over the user's own `mcp_servers`. */
  mcpServers: Readonly<Record<string, { readonly url: string }>> = {},
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
  const sqliteHome = existing.sqlite_home ?? process.env.CODEX_SQLITE_HOME ?? codexHome();
  if (typeof sqliteHome === "string") yield* restoreCodexSessionAliases(codexHome(), resolve(sqliteHome)).pipe(
    Effect.catch((error) => Effect.logWarning(`Skipping legacy Codex session repair: ${error.message}`)),
  );
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
    sqlite_home: sqliteHome,
    features: { fast_mode: true, apps: false },
    ...(Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
  };
  const name = `impact-${randomUUID()}`;
  const merged = stringify(toMerged(existing, impact));
  if (target === "home") {
    if (resolve(directory) === codexHome())
      return yield* new CliError({ message: "Impact never rewrites your own Codex config." });
    // Replace only the launch home's link; the user's source config remains untouched.
    const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".impact-config-", suffix: ".toml" });
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, merged);
    yield* fs.rename(temporary, join(directory, "config.toml"));
    return { name, overrides: [] as string[] };
  }
  const profilePath = join(directory, `${name}.config.toml`);
  yield* Effect.addFinalizer(() => fs.remove(profilePath, { force: true }).pipe(Effect.ignore));
  yield* fs.writeFileString(profilePath, merged, { mode: 0o600 });
  const overrides = Object.entries(flattenObject(impact)).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
  return { name, overrides };
}, mapPlatformError("Cannot write the Codex profile"));

import { Effect, FileSystem, Schema } from "effect";
import envPaths from "env-paths";
import { join } from "node:path";

import { CliError, mapPlatformError } from "../Errors.ts";
import { apiKey, baseUrl, Connection, DEFAULT_BASE_URL } from "./Connection.ts";

const ConnectionJson = Schema.fromJsonString(Connection);
const configDirectory = () => process.env.IMPACT_CONFIG_DIR ?? envPaths("impact", { suffix: "" }).config;
const configFile = () => join(configDirectory(), "credentials.json");

export const readConnection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(configFile())
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  return contents === undefined ? undefined : yield* Schema.decodeEffect(ConnectionJson)(contents);
}).pipe(
  Effect.mapError(
    () => new CliError({ message: "Cannot read the saved Impact login. Run impact login --base-url <url> again." }),
  ),
);

/** `--base-url`, then `IMPACT_BASE_URL`, then the saved login's endpoint. */
export const resolveEndpoint = (saved: Connection | undefined, override?: string) =>
  baseUrl(override ?? process.env.IMPACT_BASE_URL ?? saved?.baseUrl ?? DEFAULT_BASE_URL);

export const currentConnection = Effect.gen(function* () {
  const saved = process.env.IMPACT_API_KEY && process.env.IMPACT_BASE_URL ? undefined : yield* readConnection;
  const endpoint = yield* resolveEndpoint(saved);
  if (process.env.IMPACT_API_KEY) return { baseUrl: endpoint, apiKey: yield* apiKey(process.env.IMPACT_API_KEY) };
  if (!saved) return yield* new CliError({ message: "Run impact login, or set IMPACT_API_KEY." });
  if (saved.baseUrl !== endpoint)
    return yield* new CliError({
      message: "The saved key belongs to a different Impact endpoint. Run impact login --base-url <url>.",
    });
  return saved;
});

export const saveConnection = Effect.fn("saveConnection")(
  function* (value: Connection) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(configDirectory(), { recursive: true, mode: 0o700 });
    const temporary = yield* fs.makeTempFileScoped({ directory: configDirectory(), prefix: ".credentials-" });
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, `${yield* Schema.encodeEffect(ConnectionJson)(value).pipe(Effect.orDie)}\n`);
    yield* fs.rename(temporary, configFile());
  },
  Effect.scoped,
  mapPlatformError("Cannot save the Impact login"),
);

export const removeConnection = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.remove(configFile(), { force: true }),
).pipe(mapPlatformError("Cannot remove the saved Impact login"));

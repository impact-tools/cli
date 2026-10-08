import { Effect, FileSystem } from "effect";
import envPaths from "env-paths";
import { dirname, join } from "node:path";

import type { LaunchOptions } from "../Client.ts";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { cursorProxy } from "./Proxy.ts";

const RESERVED = ["--test-backend-url", "--user-data-dir", "--reuse-window", "-r"];

const homeDirectory = () => process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();

/** Cursor keeps its Desktop session in this SQLite state store. */
const defaultCursorUserDataDir = () => {
  if (process.platform === "darwin") return join(homeDirectory(), "Library", "Application Support", "Cursor");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homeDirectory(), "AppData", "Roaming"), "Cursor");
  return join(process.env.XDG_CONFIG_HOME ?? join(homeDirectory(), ".config"), "Cursor");
};

const authStateFile = (directory: string) => join(directory, "User", "globalStorage", "state.vscdb");

const bootstrapCursorSession = Effect.fnUntraced(
  function* (fs: FileSystem.FileSystem, target: string) {
    const sourceDirectory = process.env.IMPACT_CURSOR_PROFILE_SOURCE ?? defaultCursorUserDataDir();
    const source = authStateFile(sourceDirectory);
    const destination = authStateFile(target);
    const marker = join(target, ".impact-auth-bootstrap");
    if (source === destination || !(yield* fs.exists(source)) || (yield* fs.exists(marker))) return;
    yield* fs.makeDirectory(dirname(destination), { recursive: true, mode: 0o700 });
    yield* fs.copyFile(source, destination);
    yield* fs.chmod(destination, 0o600);
    // SQLite may have a live WAL while Cursor is open. Copy sidecars when present so the
    // managed profile sees the same committed auth rows on the first launch.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${source}${suffix}`;
      if (yield* fs.exists(sidecar)) yield* fs.copyFile(sidecar, `${destination}${suffix}`);
    }
    yield* fs.writeFileString(marker, `${source}\n`);
    yield* fs.chmod(marker, 0o600);
  },
  Effect.catch(() => Effect.void),
);

/** A separate profile keeps the normal Desktop process from swallowing the backend override. */
export const prepareCursor = Effect.fn("prepareCursor")(function* ({ executable, args, connection }: LaunchOptions) {
  if (/[\\/](?:\.cursor-server|remote-cli)[\\/]/.test(executable))
    return yield* new CliError({
      message:
        "Run impact cursor on the computer with Cursor Desktop installed; the remote CLI cannot configure Desktop Tab.",
    });
  if (args.some((arg) => RESERVED.some((name) => arg === name || arg.startsWith(`${name}=`))))
    return yield* new CliError({
      message: "Impact supplies Cursor's backend and profile. Use IMPACT_CURSOR_USER_DATA_DIR to select a profile.",
    });
  const directory =
    process.env.IMPACT_CURSOR_USER_DATA_DIR ??
    join(process.env.IMPACT_CONFIG_DIR ?? envPaths("impact", { suffix: "" }).config, "cursor", "profile");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* bootstrapCursorSession(fs, directory);
  const proxy = yield* cursorProxy(connection);
  const {
    IMPACT_API_KEY: _key,
    IMPACT_LAUNCH_CWD: _cwd,
    VSCODE_IPC_HOOK_CLI: _ipc,
    ELECTRON_RUN_AS_NODE: _node,
    ...env
  } = process.env;
  return {
    args: ["--user-data-dir", directory, `--test-backend-url=${proxy.baseUrl}`, "--wait", ...args],
    env,
  };
}, mapPlatformError("Cannot create the Cursor profile"));

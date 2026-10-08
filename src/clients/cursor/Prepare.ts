import { Effect, FileSystem } from "effect";
import envPaths from "env-paths";
import { join } from "node:path";

import type { LaunchOptions } from "../Client.ts";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { cursorProxy } from "./Proxy.ts";

const RESERVED = ["--test-backend-url", "--user-data-dir", "--reuse-window", "-r"];

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

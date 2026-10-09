import { Effect, FileSystem } from "effect";

import type { LaunchOptions } from "../Client.ts";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { Output } from "../../ui/Output.ts";
import { cursorProxy } from "./Proxy.ts";

const RESERVED = ["--test-backend-url", "--user-data-dir", "--reuse-window", "-r"];

/**
 * Start Cursor against the user's existing profile. A separate profile is opt-in only:
 * copying Cursor's SQLite state loses extensions, themes and editor settings, and can
 * leave the user signed out when the Desktop schema changes.
 */
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
  const proxy = yield* cursorProxy(connection);
  const output = yield* Output;
  if (output.stdout.decorative) yield* output.notice("primary", `Cursor proxy started at ${proxy.baseUrl}`);
  const profile = process.env.IMPACT_CURSOR_USER_DATA_DIR;
  if (profile) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(profile, { recursive: true, mode: 0o700 });
  }
  const {
    IMPACT_API_KEY: _key,
    IMPACT_LAUNCH_CWD: _cwd,
    VSCODE_IPC_HOOK_CLI: _ipc,
    ELECTRON_RUN_AS_NODE: _node,
    ...env
  } = process.env;
  return {
    args: [
      ...(profile ? ["--user-data-dir", profile] : []),
      `--test-backend-url=${proxy.baseUrl}`,
      "--wait",
      ...args,
    ],
    env,
  };
}, mapPlatformError("Cannot prepare the Cursor launch"));

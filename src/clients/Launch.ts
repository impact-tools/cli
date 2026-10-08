import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { Connection } from "../config/Connection.ts";

import { CliError, mapPlatformError } from "../Errors.ts";
import { prepareClaude } from "./claude/Prepare.ts";
import { executableVariable, findExecutable } from "./Client.ts";
import { prepareCodex } from "./codex/Prepare.ts";
import { prepareCursor } from "./cursor/Prepare.ts";
import { prepareKilo, prepareOpenCode } from "./opencode/Prepare.ts";

export const clients = {
  claude: { label: "Claude Code", prepare: prepareClaude },
  codex: { label: "Codex CLI", prepare: prepareCodex },
  cursor: { label: "Cursor Desktop", prepare: prepareCursor },
  kilo: { label: "Kilo Code CLI", prepare: prepareKilo },
  opencode: { label: "OpenCode", prepare: prepareOpenCode },
};
export type Client = keyof typeof clients;
export const CLIENTS = Object.keys(clients) as Client[];
export const isClient = (name: string): name is Client => Object.hasOwn(clients, name);

/** Runs the native client; without a connection (`--help`, `--version`) it starts unmodified. */
export const launch = Effect.fn("launch")(function* (client: Client, args: readonly string[], connection?: Connection) {
  const { label, prepare } = clients[client];
  const executable = findExecutable(client);
  if (!executable) return yield* new CliError({ message: `Install ${label}, or set ${executableVariable(client)}.` });
  const prepared = connection ? yield* prepare({ executable, args, connection }) : { args, env: process.env };
  const { IMPACT_LAUNCH_CWD: _, ...env }: NodeJS.ProcessEnv = prepared.env;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  process.exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(executable, prepared.args, {
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
        forceKillAfter: "5 seconds",
      }),
    )
    .pipe(mapPlatformError(`Cannot run ${label}`));
}, Effect.scoped);

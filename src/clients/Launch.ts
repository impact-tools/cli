import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";

import type { Connection } from "../config/Connection.ts";

import { CliError, mapPlatformError } from "../Errors.ts";
import { prepareClaude } from "./claude/Prepare.ts";
import { prepareAntigravity } from "./antigravity/Prepare.ts";
import { executableVariable, findExecutable } from "./Client.ts";
import { prepareCodex } from "./codex/Prepare.ts";
import { prepareCursor } from "./cursor/Prepare.ts";
import { offerMcp } from "./McpOffer.ts";
import { prepareKilo, prepareOpenCode } from "./opencode/Prepare.ts";

/** `mcp`: the launch adds Impact's MCP servers that `impact mcp enable` turned on. */
export const clients = {
  antigravity: { label: "Antigravity", prepare: prepareAntigravity, mcp: false },
  claude: { label: "Claude Code", prepare: prepareClaude, mcp: true },
  codex: { label: "Codex CLI", prepare: prepareCodex, mcp: true },
  cursor: { label: "Cursor Desktop", prepare: prepareCursor, mcp: false },
  kilo: { label: "Kilo Code CLI", prepare: prepareKilo, mcp: true },
  opencode: { label: "OpenCode", prepare: prepareOpenCode, mcp: true },
};
export type Client = keyof typeof clients;
export const CLIENTS = Object.keys(clients) as Client[];
export const isClient = (name: string): name is Client => Object.hasOwn(clients, name);

/** Starts a desktop client that outlives this command; its output goes to `log`. */
const detached = (
  label: string,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  output: { readonly log: string; readonly append: boolean },
) =>
  Effect.tryPromise({
    try: async () => {
      const log = openSync(output.log, output.append ? "a" : "w", 0o600);
      try {
        const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", log, log] });
        await Promise.race([once(child, "spawn"), once(child, "error").then(([error]) => Promise.reject(error))]);
        child.unref();
      } finally {
        closeSync(log);
      }
    },
    catch: () => new CliError({ message: `Cannot run ${label}.` }),
  });

/** Runs the native client; without a connection (`--help`, `--version`) it starts unmodified. */
export const launch = Effect.fn("launch")(function* (client: Client, args: readonly string[], connection?: Connection) {
  const { label, prepare, mcp } = clients[client];
  const executable = findExecutable(client);
  if (!executable) return yield* new CliError({ message: `Install ${label}, or set ${executableVariable(client)}.` });
  if (connection && mcp) yield* offerMcp();
  const prepared = connection ? yield* prepare({ executable, args, connection }) : { args, env: process.env };
  const { IMPACT_LAUNCH_CWD: _, ...env }: NodeJS.ProcessEnv = prepared.env;
  if ("detach" in prepared) return yield* detached(label, executable, prepared.args, env, prepared.detach);
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

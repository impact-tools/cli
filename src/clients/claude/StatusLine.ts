import { Effect, FileSystem, Schedule, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Connection } from "../../config/Connection.ts";
import type { StatusLine } from "./Config.ts";

import { fetchUsage, usageSummary } from "../../api/Usage.ts";
import { mapPlatformError } from "../../Errors.ts";
import { helperCommand } from "../../process/Self.ts";
import { makeOwnedDirectory, removeOrphans } from "../Scratch.ts";

const PREFIX = "impact-claude-status-";

const Snapshot = Schema.Struct({ line: Schema.String, command: Schema.optional(Schema.String) });

/** Keeps a wallet snapshot fresh for the launch; Claude's status command only reads the file. */
export const prepareStatusLine = Effect.fn("prepareStatusLine")(function* (
  connection: Connection,
  existing: StatusLine | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* removeOrphans(tmpdir(), PREFIX);
  const directory = yield* makeOwnedDirectory({ directory: tmpdir(), prefix: PREFIX });
  const path = join(directory, "status.json");
  const temporary = join(directory, "status.tmp");
  const refresh = fetchUsage(connection, "2 seconds").pipe(
    Effect.map((usage) => usageSummary(connection, usage)),
    Effect.orElseSucceed(() => `Impact · ${connection.baseUrl} · balance unavailable`),
    Effect.flatMap((line) =>
      fs.writeFileString(temporary, JSON.stringify({ line, command: existing?.command }), { mode: 0o600 }),
    ),
    Effect.andThen(fs.rename(temporary, path)),
  );
  yield* refresh;
  yield* refresh.pipe(Effect.ignore, Effect.schedule(Schedule.spaced("30 seconds")), Effect.forkScoped);
  return {
    path,
    settings: {
      ...existing,
      type: "command" as const,
      command: helperCommand("status-line"),
      refreshInterval: existing?.refreshInterval ?? 30,
    },
  };
}, mapPlatformError("Cannot create the Claude status line file"));

/** Runs inside Claude: the user's own status line first, then the Impact line. */
export function renderStatusLine(): void {
  const path = process.env.IMPACT_CLAUDE_STATUS_FILE;
  if (!path) return;
  const input = readFileSync(0, "utf8");
  const snapshot = Schema.decodeSync(Schema.fromJsonString(Snapshot))(readFileSync(path, "utf8"));
  if (snapshot.command) {
    const output = spawnSync(snapshot.command, { shell: true, input, encoding: "utf8", timeout: 3_000 }).stdout ?? "";
    process.stdout.write(output);
    if (output && !output.endsWith("\n")) process.stdout.write("\n");
  }
  process.stdout.write(`${snapshot.line}\n`);
}

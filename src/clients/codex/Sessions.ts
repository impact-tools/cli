import { Effect, FileSystem } from "effect";
import { join, relative, sep } from "node:path";

import { mapPlatformError, CliError } from "../../Errors.ts";
import { openSqlite } from "../../process/Sqlite.ts";

type ThreadRow = { readonly rollout_path: string };

/** Codex's shared index is only read; `readOnly` keeps it that way on either runtime. */
const readRolloutPaths = async (path: string): Promise<ThreadRow[]> => {
  const db = await openSqlite(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get()) return [];
    return db.prepare("SELECT DISTINCT rollout_path FROM threads WHERE rollout_path IS NOT NULL").all() as ThreadRow[];
  } finally {
    db.close();
  }
};

/** Restore aliases removed by older launchers without changing Codex's shared index. */
export const restoreCodexSessionAliases = Effect.fn("restoreCodexSessionAliases")(function* (
  source: string,
  sqliteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(sqliteHome))) return;
  const entries = yield* fs.readDirectory(sqliteHome);
  for (const entry of entries.filter((name) => /^state_\d+\.sqlite$/.test(name))) {
    const paths = yield* Effect.tryPromise({
      try: () => readRolloutPaths(join(sqliteHome, entry)),
      catch: (cause) =>
        new CliError({ message: `Skipping Codex session index ${join(sqliteHome, entry)}: ${String(cause)}` }),
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as([] as ThreadRow[]))));
    const aliases = new Set<string>();
    for (const { rollout_path } of paths) {
      const [alias, kind] = relative(source, rollout_path).split(sep);
      if (/^\.impact-[A-Za-z0-9]+$/.test(alias ?? "") && (kind === "sessions" || kind === "archived_sessions"))
        aliases.add(alias!);
    }
    for (const alias of aliases) {
      const directory = join(source, alias);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      for (const name of ["sessions", "archived_sessions", "shell_snapshots"]) {
        const link = join(directory, name);
        if (yield* fs.exists(link)) continue;
        yield* fs.makeDirectory(join(source, name), { recursive: true });
        yield* fs
          .symlink(join(source, name), link)
          .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
      }
    }
  }
}, mapPlatformError("Cannot restore the Codex session paths"));

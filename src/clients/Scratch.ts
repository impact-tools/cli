import { DateTime, Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { hostname } from "node:os";
import { join } from "node:path";

const OWNER_FILE = ".impact-owner";
const Owner = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, host: Schema.String }));
/** `mkdtemp`'s random suffix: what an unmarked directory from an older release ends with. */
const LEGACY_SUFFIX = /^[A-Za-z0-9]{6}$/;
const LEGACY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

/**
 * A scoped temporary directory marked with this process. The scope removes it on a normal exit;
 * when the process dies without running finalizers, a later launch removes it with
 * {@link removeOrphans}.
 */
export const makeOwnedDirectory = Effect.fn("makeOwnedDirectory")(function* (options: {
  readonly prefix: string;
  readonly directory?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped(options);
  yield* fs.writeFileString(join(directory, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname() }), {
    mode: 0o600,
  });
  return directory;
});

/**
 * Removes `prefix` directories in `parent` whose launch is gone: the marked process has exited on
 * this host, or, without a marker, the directory has been untouched for a week. Best effort.
 */
export const removeOrphans = Effect.fn("removeOrphans")(
  function* (parent: string, prefix: string) {
    const fs = yield* FileSystem.FileSystem;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const name of yield* fs.readDirectory(parent)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(parent, name);
      const owner = yield* fs
        .readFileString(join(path, OWNER_FILE))
        .pipe(Effect.flatMap(Schema.decodeEffect(Owner)), Effect.option);
      if (Option.isSome(owner)) {
        if (owner.value.host !== hostname() || isAlive(owner.value.pid)) continue;
      } else {
        if (!LEGACY_SUFFIX.test(name.slice(prefix.length))) continue;
        const info = yield* fs.stat(path).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "Directory") continue;
        const modified = Option.getOrUndefined(info.value.mtime)?.getTime() ?? now;
        if (now - modified < LEGACY_AGE_MS) continue;
      }
      yield* fs.remove(path, { recursive: true }).pipe(Effect.ignore);
    }
  },
  (effect) => Effect.ignore(effect),
);

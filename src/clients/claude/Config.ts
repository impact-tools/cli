import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { toMerged } from "es-toolkit";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CliError, mapPlatformError } from "../../Errors.ts";

const Settings = Schema.Record(Schema.String, Schema.Unknown);
type Settings = typeof Settings.Type;
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(Settings));

export const StatusLine = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  padding: Schema.optional(Schema.Finite),
  refreshInterval: Schema.optional(Schema.Finite),
  hideVimModeIndicator: Schema.optional(Schema.Boolean),
});
export type StatusLine = typeof StatusLine.Type;

const SOURCES = ["user", "project", "local"] as const;

/** Takes `--settings` out of Claude's argv; the launch passes a single merged `--settings` instead. */
export function parseClaudeArgs(args: readonly string[]) {
  const { values, tokens } = parseArgs({
    args: [...args],
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      settings: { type: "string", multiple: true },
      "setting-sources": { type: "string" },
      model: { type: "string" },
    },
  });
  const removed = new Set<number>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name !== "settings") continue;
    removed.add(token.index);
    if (token.value !== undefined && !token.inlineValue) removed.add(token.index + 1);
  }
  const sources = values["setting-sources"];
  return {
    settings: [values.settings ?? []].flat(),
    sources: Predicate.isString(sources) ? sources.split(",") : SOURCES,
    model: Predicate.isString(values.model) ? values.model : undefined,
    args: args.filter((_, index) => !removed.has(index)),
  };
}

const settingsFiles = (sources: readonly string[]) => {
  const files = {
    user: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
    project: join(process.cwd(), ".claude", "settings.json"),
    local: join(process.cwd(), ".claude", "settings.local.json"),
  };
  return SOURCES.filter((source) => sources.includes(source)).map((source) => files[source]);
};

export const claudeConfig = Effect.fn("claudeConfig")(function* (argv: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const parsed = parseClaudeArgs(argv);
  let settings: Settings = {};
  for (const input of parsed.settings) {
    if (!Predicate.isString(input))
      return yield* new CliError({ message: "Pass --settings a JSON object or settings file." });
    const contents = input.trimStart().startsWith("{")
      ? input
      : yield* fs.readFileString(input).pipe(mapPlatformError(`Cannot read Claude settings ${input}`));
    const value = yield* decodeSettings(contents).pipe(
      Effect.mapError(() => new CliError({ message: "Claude --settings must contain a valid JSON object." })),
    );
    settings = toMerged(settings, value);
  }
  // Claude still reads its own files; they are only inspected here, never copied into the launch settings.
  let effective: Settings = {};
  for (const path of settingsFiles(parsed.sources)) {
    const value = yield* fs.readFileString(path).pipe(
      Effect.flatMap(decodeSettings),
      Effect.orElseSucceed(() => ({})),
    );
    effective = toMerged(effective, value);
  }
  effective = toMerged(effective, settings);
  const env = Predicate.isObject(effective.env) ? effective.env : {};
  const model = [
    parsed.model,
    process.env.IMPACT_MODEL,
    env.ANTHROPIC_MODEL,
    process.env.ANTHROPIC_MODEL,
    effective.model,
  ].find(Predicate.isString);
  return {
    /** From `--settings` only. */
    settings,
    /** What Claude will see: its settings files with `--settings` on top. */
    effective,
    statusLine: Option.getOrUndefined(Schema.decodeUnknownOption(StatusLine)(effective.statusLine)),
    model,
    args: parsed.args,
  };
});

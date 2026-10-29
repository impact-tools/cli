import { isEqual } from "es-toolkit";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { openSqlite } from "../../process/Sqlite.ts";

/** Settings the launcher always owns; they are never mirrored or preserved. */
export type Overrides = ReadonlyArray<readonly [string, unknown]>;

/** The user's own configuration. Account, model and chat state are never part of it. */
const FILES = ["keybindings.json", "tasks.json"];
const STATE = ".impact-mirror.json";
const DISABLED = "extensionsIdentifiers/disabled";
const LOCATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const regularFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const readStock = (path: string) =>
  regularFile(path) ? readFileSync(path, "utf8") : undefined;
/** A managed file never aliases another path; a link is replaced by a regular file. */
const readManaged = (path: string) => {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
};
const writeManaged = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) || isLink(path)) unlinkSync(path);
  writeFileSync(path, text, { mode: 0o600 });
};
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const parseObject = (text: string | undefined): Json | undefined => {
  if (text === undefined) return undefined;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 && isObject(value) ? value : undefined;
};
const edit = (text: string, key: string, value: unknown) =>
  applyEdits(text, modify(text, [key], value, formatting));

/**
 * Starts from the user's Cursor settings and keeps what was changed in the Impact window: keys that
 * differ from the Cursor settings mirrored on the previous launch. On the first launch the Cursor value
 * of every shared key wins and keys only the Impact window has stay.
 */
const mergeSettings = (
  stockText: string,
  managedText: string | undefined,
  lastText: string | undefined,
  overrides: Overrides,
) => {
  const stock = parseObject(stockText);
  if (!stock) return undefined;
  const managed = managedText === undefined ? {} : parseObject(managedText);
  if (!managed) throw new Error("The managed Cursor settings.json is invalid; fix it before relaunching Impact.");
  const base =
    parseObject(lastText) ??
    Object.fromEntries(Object.keys(stock).filter((key) => key in managed).map((key) => [key, managed[key]]));
  const owned = new Set(overrides.map(([key]) => key));
  let text = stockText;
  for (const key of new Set([...Object.keys(managed), ...Object.keys(base)])) {
    if (!owned.has(key) && !isEqual(managed[key], base[key])) text = edit(text, key, managed[key]);
  }
  return text;
};

interface Mirror {
  readonly state: Record<string, string>;
  readonly seen: Set<string>;
}

/** A whole file follows Cursor unless it was edited in the Impact window since the previous launch. */
const mirrorFile = (mirror: Mirror, source: string, target: string, relative: string) => {
  const path = join(target, relative);
  const stockText = readStock(join(source, relative));
  const managedText = readManaged(path);
  const last = mirror.state[relative];
  const edited = managedText !== undefined && managedText !== (last ?? stockText);
  if (stockText === undefined) {
    if (managedText !== undefined && !edited && last !== undefined) unlinkSync(path);
    return;
  }
  mirror.seen.add(relative);
  if (edited) {
    mirror.state[relative] = last ?? stockText;
    return;
  }
  if (managedText !== stockText) writeManaged(path, stockText);
  mirror.state[relative] = stockText;
};

const mirrorSettings = (
  mirror: Mirror,
  source: string,
  target: string,
  relative: string,
  overrides: Overrides,
  applyOverrides: boolean,
) => {
  const stockText = readStock(join(source, relative));
  if (stockText === undefined) return;
  const path = join(target, relative);
  const merged = mergeSettings(stockText, readManaged(path), mirror.state[relative], overrides);
  if (merged === undefined) return;
  let text = merged;
  if (applyOverrides) for (const [key, value] of overrides) text = edit(text, key, value);
  writeManaged(path, text);
  mirror.seen.add(relative);
  // The baseline is Cursor's text: a later difference from it is an Impact-window edit.
  mirror.state[relative] = stockText;
};

const mirrorSnippets = (mirror: Mirror, source: string, target: string, profile: string) => {
  const directory = join(profile, "snippets");
  let names: string[] = [];
  try {
    names = readdirSync(join(source, directory)).filter((name) => /\.(?:json|code-snippets)$/.test(name));
  } catch {
    /* No snippets in this profile. */
  }
  const previous = Object.keys(mirror.state)
    .filter((key) => dirname(key) === directory)
    .map((key) => key.slice(directory.length + 1));
  for (const name of new Set([...names, ...previous])) mirrorFile(mirror, source, target, join(directory, name));
};

/** The extension list of a named profile is shared, so neither Cursor deletes the other's extensions. */
const shareExtensions = (source: string, target: string, profile: string) => {
  const stock = join(source, profile, "extensions.json");
  const path = join(target, profile, "extensions.json");
  if (!regularFile(stock)) return;
  if (isLink(path) && readlinkSync(path) === stock) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) || isLink(path)) unlinkSync(path);
  symlinkSync(stock, path);
};

/** Cursor keeps disabled extensions in application state; read the running profile's copy only. */
const readDisabled = async (path: string): Promise<string | undefined> => {
  if (!regularFile(path)) return undefined;
  const db = await openSqlite(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(DISABLED) as
      | { value: string | Uint8Array }
      | undefined;
    if (!row) return undefined;
    return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString();
  } catch {
    return undefined;
  } finally {
    db.close();
  }
};
const writeDisabled = async (path: string, value: string | undefined) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = await openSqlite(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    if (value === undefined) db.prepare("DELETE FROM ItemTable WHERE key = ?").run(DISABLED);
    else db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(DISABLED, value);
  } finally {
    db.close();
  }
};

/**
 * Copies the user's Cursor configuration into the managed profile before each launch: settings,
 * keybindings, tasks, snippets, named profiles with their folder associations and extension lists,
 * and disabled extensions. The managed profile keeps its own sign-in, models, chats and history.
 */
export const mirrorCursorProfile = async (
  source: string,
  target: string,
  overrides: Overrides,
): Promise<{ readonly disabled: string | null } | undefined> => {
  const user = join(source, "User");
  if (!existsSync(user)) return undefined;
  const statePath = join(target, STATE);
  let state: Record<string, string> = {};
  try {
    const saved: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (isObject(saved))
      state = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    /* The first mirrored launch. */
  }
  const mirror: Mirror = { state, seen: new Set() };

  const storageRelative = join("User", "globalStorage", "storage.json");
  const stockStorage = parseObject(readStock(join(source, storageRelative))) ?? {};
  const profiles = (Array.isArray(stockStorage.userDataProfiles) ? stockStorage.userDataProfiles : []).filter(
    (profile): profile is Json & { location: string } =>
      isObject(profile) && typeof profile.location === "string" && LOCATION.test(profile.location),
  );
  const storagePath = join(target, storageRelative);
  const managedStorage = parseObject(readManaged(storagePath)) ?? {};
  if (profiles.length) managedStorage.userDataProfiles = profiles;
  else delete managedStorage.userDataProfiles;
  if (isObject(stockStorage.profileAssociations)) managedStorage.profileAssociations = stockStorage.profileAssociations;
  else delete managedStorage.profileAssociations;
  writeManaged(storagePath, `${JSON.stringify(managedStorage, null, 4)}\n`);

  for (const profile of ["User", ...profiles.map((entry) => join("User", "profiles", entry.location))]) {
    const named = profile !== "User";
    // The default profile receives the launcher's settings afterwards, with validation.
    mirrorSettings(mirror, source, target, join(profile, "settings.json"), overrides, named);
    for (const file of FILES) mirrorFile(mirror, source, target, join(profile, file));
    mirrorSnippets(mirror, source, target, profile);
    if (named) {
      shareExtensions(source, target, profile);
      const database = join("globalStorage", "state.vscdb");
      await writeDisabled(join(target, profile, database), await readDisabled(join(source, profile, database)));
    }
  }
  // Snapshots of files no longer mirrored are kept while an Impact-window edit still exists.
  const kept = Object.entries(mirror.state).filter(
    ([key]) => mirror.seen.has(key) || readManaged(join(target, key)) !== undefined,
  );
  writeManaged(statePath, `${JSON.stringify(Object.fromEntries(kept))}\n`);
  return { disabled: (await readDisabled(join(user, "globalStorage", "state.vscdb"))) ?? null };
};

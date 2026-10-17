import { Effect, FileSystem, Schema } from "effect";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { CliError, mapPlatformError } from "../../Errors.ts";
import { mirrorCursorProfile, type Overrides } from "./Mirror.ts";

const REACTIVE =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const Account = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  token: Schema.String,
  refreshToken: Schema.String,
});
const Lock = Schema.Struct({ pid: Schema.Int, nonce: Schema.String });
const Record = Schema.Record(Schema.String, Schema.Unknown);
const record = (value: unknown): Record<string, any> =>
  Schema.decodeUnknownSync(Record)(value ?? {});
const AUTH_KEYS = [
  "accessToken",
  "refreshToken",
  "cachedEmail",
  "cachedSignUpType",
  "cachedScopedProfile",
  "cachedTeam",
  "teamId",
  "stripeCustomerId",
  "stripeMembershipType",
  "stripeMembershipAuthId",
  "stripeSubscriptionStatus",
  "openAIKey",
  "claudeKey",
  "googleKey",
  "azureApiKey",
  "bedrockAccessKey",
  "bedrockSecretKey",
];

/** Proxy, transport and update settings the launch depends on; the user's own values never apply. */
const MANAGED_SETTINGS: Overrides = [
  ["http.proxy", undefined],
  ["http.proxyAuthorization", undefined],
  ["http.proxyStrictSSL", true],
  ["http.proxySupport", "override"],
  ["cursor.general.disableHttp2", true],
  ["cursor.general.disableHttp1SSE", false],
  ["update.mode", "none"],
];

const defaultProfile = () => {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("Cannot determine the default Cursor profile.");
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Cursor");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Cursor",
    );
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor");
};
const canonical = (path: string): string => {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (ancestor === parent)
      throw new Error("Cannot resolve the Cursor profile path.");
    suffix.unshift(
      ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
    );
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
};
const running = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** The canonical managed directory; it must be outside the user's own Cursor profile. */
const separateProfile = (directory: string) => {
  const target = canonical(directory);
  const original = canonical(defaultProfile());
  const difference = relative(original, target);
  if (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  )
    throw new Error(
      "Use a separate IMPACT_CURSOR_USER_DATA_DIR; the normal Cursor profile must remain untouched.",
    );
  return target;
};
/**
 * Cursor's main process writes its PID to `code.lock`; Chromium's SingletonLock, when present, names
 * the host and PID that own the profile.
 */
const owned = (target: string) => {
  try {
    const pid = Number(readFileSync(join(target, "code.lock"), "utf8").trim());
    if (running(pid)) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const path = join(target, "SingletonLock");
    // Chromium uses a host/PID symlink on Unix. A regular file is also left
    // behind by stale and Windows profiles, so it is not proof of ownership.
    if (!lstatSync(path).isSymbolicLink()) return false;
    const match = /^(.*)-(\d+)$/.exec(readlinkSync(path));
    return !match || match[1] !== hostname() || running(Number(match[2]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const assertSafeProfile = (directory: string) => {
  const target = separateProfile(directory);
  if (owned(target))
    throw new Error(
      "Cursor already owns this profile. Close only its Impact window before relaunching.",
    );
  return target;
};

/** Whether an Impact Cursor instance already runs on this managed profile. */
export const cursorProfileInUse = (directory: string) =>
  Effect.try({
    try: () => owned(separateProfile(directory)),
    catch: (error) =>
      new CliError({
        message: String(error instanceof Error ? error.message : error),
      }),
  });

/** Locate descriptor data only; never start or evaluate application code. */
export function resolveCursorApp(executable: string): string {
  const override = process.env.IMPACT_CURSOR_APP_DIR;
  if (override) return resolve(override);
  const path = realpathSync(executable);
  const bundle = /^(.*?\.app)(?:\/|$)/.exec(path)?.[1];
  if (
    bundle &&
    existsSync(
      join(
        bundle,
        "Contents",
        "Resources",
        "app",
        "out",
        "vs",
        "workbench",
        "workbench.desktop.main.js",
      ),
    )
  )
    return bundle;
  let parent = dirname(path);
  while (true) {
    for (const candidate of [
      join(parent, "resources", "app"),
      join(parent, "Resources", "app"),
      parent,
    ]) {
      if (
        existsSync(
          join(
            candidate,
            "out",
            "vs",
            "workbench",
            "workbench.desktop.main.js",
          ),
        )
      )
        return candidate;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  throw new Error(
    "Cannot locate Cursor Desktop descriptors. Set IMPACT_CURSOR_APP_DIR to its application directory.",
  );
}

const acquireLock = (directory: string) => {
  const path = join(directory, ".impact-launch-lock");
  const metadata = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try {
    const handle = openSync(path, "wx", 0o600);
    try {
      writeFileSync(handle, metadata);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid: number; nonce: string };
    try {
      owner = Schema.decodeUnknownSync(Lock)(
        JSON.parse(readFileSync(path, "utf8")),
      );
    } catch {
      throw new Error(
        `The Impact profile lock is unreadable. Remove ${path} after verifying its Cursor window is closed.`,
      );
    }
    if (running(owner.pid))
      throw new Error(
        "An Impact launch already owns this Cursor profile. Use another IMPACT_CURSOR_USER_DATA_DIR for another window.",
      );
    // Recovery is itself exclusive so two launches cannot remove each other's new lock.
    const recovery = `${path}.recovery`;
    let handle: number;
    try {
      handle = openSync(recovery, "wx", 0o600);
    } catch {
      throw new Error(
        "Another launch is recovering the Cursor profile lock. Retry shortly.",
      );
    }
    try {
      const current = Schema.decodeUnknownSync(Lock)(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (current.nonce !== owner.nonce || running(current.pid))
        throw new Error("Another launch owns this Cursor profile.");
      unlinkSync(path);
      const lock = openSync(path, "wx", 0o600);
      try {
        writeFileSync(lock, metadata);
      } finally {
        closeSync(lock);
      }
    } finally {
      closeSync(handle);
      unlinkSync(recovery);
    }
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === metadata) unlinkSync(path);
    } catch {
      /* A missing lock has already been released. */
    }
  };
};

const seed = async (
  path: string,
  account: { id: string; email: string; token: string; refreshToken: string },
  modelIds: readonly string[],
  disabledExtensions: string | null | undefined,
) => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); BEGIN IMMEDIATE",
    );
    const get = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
    const put = db.prepare(
      "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
    );
    const del = db.prepare("DELETE FROM ItemTable WHERE key = ?");
    const stored = get.get(REACTIVE) as
      { value: string | Uint8Array } | undefined;
    const state = record(
      stored
        ? JSON.parse(
            typeof stored.value === "string"
              ? stored.value
              : Buffer.from(stored.value).toString(),
          )
        : {},
    );
    const ai = record(state.aiSettings);
    const configs = record(ai.modelConfig);
    const model = modelIds[0]!;
    for (const surface of [
      "composer",
      "cmd-k",
      "background-composer",
      "composer-ensemble",
      "plan-execution",
      "spec",
      "deep-search",
      "quick-agent",
    ]) {
      const config = record(configs[surface]);
      const selected =
        typeof config.modelName === "string" &&
        modelIds.includes(config.modelName)
          ? config.modelName
          : model;
      configs[surface] = {
        ...config,
        modelName: selected,
        selectedModels: [{ modelId: selected, parameters: [] }],
        maxMode: false,
      };
    }
    ai.modelConfig = configs;
    ai.modelOverrideEnabled = [...modelIds];
    ai.modelOverrideDisabled = [];
    for (const key of [
      "openAIKey",
      "openAiKey",
      "claudeKey",
      "googleKey",
      "apiKey",
      "openAIBaseUrl",
      "openAIBaseUrlOverride",
    ])
      delete ai[key];
    ai.useOpenAIKey = false;
    ai.useClaudeKey = false;
    ai.useGoogleKey = false;
    state.azureState = { ...record(state.azureState), useAzure: false };
    delete state.azureState.apiKey;
    state.bedrockState = { ...record(state.bedrockState), useBedrock: false };
    delete state.bedrockState.accessKey;
    delete state.bedrockState.secretKey;
    // The native picker needs a paid UI profile to expose the Impact catalog.
    // Keep provider-key mode off so models use the native Impact transport.
    state.useOpenAIKey = false;
    state.useClaudeKey = false;
    state.useGoogleKey = false;
    delete state.openAIBaseUrl;
    state.havePerformedSettingsServiceMigration = true;
    state.availableAPIKeyModels = [];
    state.aiSettings = ai;
    state.membershipType = "pro";
    state.subscriptionStatus = "active";
    state.cppEnabled = true;
    state.indexRepository = false;
    state.isFileSyncClientEnabled = false;
    // Legacy settings migration must not resurrect provider credentials or
    // enable provider-key mode on the first managed launch.
    del.run("aisettings.service");
    for (const key of AUTH_KEYS) {
      del.run(`cursorAuth/${key}`);
      del.run(`secret://cursorAuth/${key}`);
    }
    for (const [key, value] of Object.entries({
      accessToken: account.token,
      refreshToken: account.refreshToken,
      cachedEmail: `Impact · ${account.email}`,
      stripeMembershipType: "pro",
      stripeMembershipAuthId: account.id,
      stripeSubscriptionStatus: "active",
    }))
      put.run(`cursorAuth/${key}`, value);
    put.run(REACTIVE, JSON.stringify(state));
    // Extensions disabled in the user's Cursor stay disabled in the Impact window.
    if (disabledExtensions === null) del.run("extensionsIdentifiers/disabled");
    else if (disabledExtensions !== undefined)
      put.run("extensionsIdentifiers/disabled", disabledExtensions);
    put.run(
      "cursorai/serverConfig",
      JSON.stringify({
        configVersion: "impact-local-1",
        http2Config: "HTTP2_CONFIG_FORCE_ALL_DISABLED",
        chatConfig: { disableStatsig: true },
        metricsConfig: {
          enabledInPrivacyMode: false,
          enabledInNonPrivacyMode: false,
        },
        agentUrlConfig: {
          agentUrl: "https://agent.api5.cursor.sh",
          agentnUrl: "https://agent.api5.cursor.sh",
        },
      }),
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};

const stockProfile = () => {
  try {
    return defaultProfile();
  } catch {
    return undefined;
  }
};

/**
 * Acquire ownership before touching auth. The user's Cursor configuration is copied in; its sign-in,
 * account state and chats are never read, and the stock profile is never written.
 */
export const prepareCursorProfile = Effect.fn("prepareCursorProfile")(
  function* (
    directory: string,
    account: { id: string; email: string; token: string; refreshToken: string },
    modelIds: readonly string[],
    source: string | undefined = stockProfile(),
  ) {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* Effect.try({
      try: () => {
        Schema.decodeUnknownSync(Account)(account);
        if (!modelIds.length || modelIds.some((id) => !id))
          throw new Error("Impact returned no usable models.");
        return assertSafeProfile(directory);
      },
      catch: (error) =>
        new CliError({
          message: String(error instanceof Error ? error.message : error),
        }),
    });
    yield* fs.makeDirectory(target, { recursive: true, mode: 0o700 });
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => acquireLock(target),
        catch: (error) =>
          new CliError({
            message: String(error instanceof Error ? error.message : error),
          }),
      }),
      (release) => Effect.sync(release),
    );
    // Recheck Electron ownership after the launch lock, before any state mutation.
    yield* Effect.try({
      try: () => assertSafeProfile(target),
      catch: (error) =>
        new CliError({
          message: String(error instanceof Error ? error.message : error),
        }),
    });
    const storage = join(target, "User", "globalStorage");
    yield* Effect.try({
      try: () => {
        for (const path of [
          join(target, "User"),
          storage,
          join(target, "User", "settings.json"),
        ]) {
          const difference = relative(target, canonical(path));
          if (
            difference === ".." ||
            difference.startsWith(`..${sep}`) ||
            isAbsolute(difference)
          )
            throw new Error(
              "Managed Cursor storage must not link outside its profile directory.",
            );
        }
      },
      catch: (error) =>
        new CliError({
          message: String(error instanceof Error ? error.message : error),
        }),
    });
    yield* fs.makeDirectory(storage, { recursive: true, mode: 0o700 });
    const database = join(storage, "state.vscdb");
    // Refuse a symlinked DB too: a managed directory must not alias stock state.
    yield* Effect.try({
      try: () => {
        for (const path of [
          database,
          `${database}-wal`,
          `${database}-shm`,
          join(target, "User", "settings.json"),
        ]) {
          if (
            existsSync(path) &&
            (lstatSync(path).isSymbolicLink() || lstatSync(path).nlink > 1)
          )
            throw new Error(
              "Managed Cursor account storage must not use symlinks or hard links.",
            );
        }
      },
      catch: (error) =>
        new CliError({
          message: String(error instanceof Error ? error.message : error),
        }),
    });
    const mirrored =
      source === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => mirrorCursorProfile(source, target, MANAGED_SETTINGS),
            catch: (error) =>
              new CliError({
                message:
                  error instanceof Error && error.message.includes("settings.json is invalid")
                    ? error.message
                    : "Cannot copy your Cursor settings into the Impact profile.",
              }),
          });
    yield* Effect.try({
      try: () => {
        if (!existsSync(database)) {
          const file = openSync(database, "wx", 0o600);
          closeSync(file);
        }
      },
      catch: () =>
        new CliError({
          message: "Cannot create private Cursor account storage.",
        }),
    });
    yield* fs.chmod(database, 0o600);
    yield* Effect.tryPromise({
      try: () => seed(database, account, modelIds, mirrored?.disabled),
      catch: () =>
        new CliError({
          message:
            "Cannot initialize the Impact Cursor account or model settings.",
        }),
    });
    yield* fs.chmod(database, 0o600);
    const settingsPath = join(target, "User", "settings.json");
    const original = (yield* fs.exists(settingsPath))
      ? yield* fs.readFileString(settingsPath)
      : "{}\n";
    const errors: ParseError[] = [];
    const settings = parse(original, errors, { allowTrailingComma: true });
    const valid = Schema.decodeUnknownExit(Record)(settings);
    if (errors.length || valid._tag === "Failure")
      return yield* new CliError({
        message:
          "The managed Cursor settings.json is invalid; fix it before relaunching Impact.",
      });
    let updated = original;
    for (const [key, value] of MANAGED_SETTINGS) {
      updated = applyEdits(
        updated,
        modify(updated, [key], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    }
    yield* fs.writeFileString(settingsPath, updated);
  },
  mapPlatformError("Cannot prepare the Impact Cursor profile"),
);

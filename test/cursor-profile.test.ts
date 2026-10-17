import { NodeServices } from "@effect/platform-node";
import { Effect, type FileSystem, type Scope } from "effect";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cursorProfileInUse,
  prepareCursorProfile,
  resolveCursorApp,
} from "../src/clients/cursor/Profile.ts";

const REACTIVE =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const account = {
  id: "impact-account",
  email: "test@example.com",
  token: "local-only-jwt",
  refreshToken: "local-only-refresh",
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "impact-cursor-profile-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
// The user's real Cursor profile must never feed these tests.
const noStock = () => join(directory, "no-stock");
const database = () => join(directory, "User", "globalStorage", "state.vscdb");
const readRows = () => {
  const db = new DatabaseSync(database());
  try {
    return Object.fromEntries(
      (
        db.prepare("SELECT key,value FROM ItemTable").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((row) => [row.key, row.value]),
    );
  } finally {
    db.close();
  }
};

it("seeds local identity/models while preserving managed history, user settings and JSONC comments", async () => {
  await mkdir(join(directory, "User", "globalStorage"), { recursive: true });
  const db = new DatabaseSync(database());
  db.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB)",
  );
  const insert = db.prepare("INSERT INTO ItemTable VALUES (?,?)");
  insert.run("composer.history", "keep-history");
  insert.run("cursorAuth/accessToken", "old-cursor-session");
  insert.run("cursorAuth/openAIKey", "old-key");
  insert.run("secret://cursorAuth/openAIKey", "encrypted-old-key");
  insert.run("secret://extension-keep", "encrypted-extension-key");
  insert.run(
    "aisettings.service",
    JSON.stringify({ useOpenAIKey: false, availableModels: ["old"] }),
  );
  insert.run(
    REACTIVE,
    JSON.stringify({
      personalDocs: [{ identifier: "keep-doc" }],
      useClaudeKey: true,
      useGoogleKey: true,
      openAIBaseUrl: "https://old.example/v1",
      aiSettings: {
        customPreference: 42,
        openAIKey: "old-key",
        modelConfig: { composer: { modelName: "impact-model", other: true } },
      },
    }),
  );
  db.close();
  await writeFile(
    join(directory, "User", "settings.json"),
    '{\n  // keep my comment\n  "editor.fontSize": 17,\n  "http.proxy": "http://old:123",\n  "http.proxyAuthorization": "old-secret",\n}\n',
  );
  await run(
    prepareCursorProfile(directory, account, ["impact-model", "other-model"], noStock()),
  );
  const rows = readRows();
  expect(rows["composer.history"]).toBe("keep-history");
  expect(rows["cursorAuth/accessToken"]).toBe("local-only-jwt");
  expect(rows["cursorAuth/refreshToken"]).toBe("local-only-refresh");
  expect(rows["cursorAuth/cachedEmail"]).toBe("Impact · test@example.com");
  expect(rows["cursorAuth/stripeMembershipType"]).toBe("pro");
  expect(rows["cursorAuth/stripeSubscriptionStatus"]).toBe("active");
  expect(rows["cursorAuth/openAIKey"]).toBeUndefined();
  expect(rows["secret://cursorAuth/openAIKey"]).toBeUndefined();
  expect(rows["secret://extension-keep"]).toBe("encrypted-extension-key");
  const state = JSON.parse(rows[REACTIVE]!);
  expect(state.personalDocs).toEqual([{ identifier: "keep-doc" }]);
  expect(state.aiSettings.customPreference).toBe(42);
  expect(state.aiSettings.openAIKey).toBeUndefined();
  expect(state.aiSettings.modelConfig.composer).toMatchObject({
    modelName: "impact-model",
    other: true,
    selectedModels: [{ modelId: "impact-model", parameters: [] }],
  });
  expect(state.isFileSyncClientEnabled).toBe(false);
  expect(state.membershipType).toBe("pro");
  expect(state.subscriptionStatus).toBe("active");
  expect(state.useOpenAIKey).toBe(false);
  expect(state.useClaudeKey).toBe(false);
  expect(state.useGoogleKey).toBe(false);
  expect(state.openAIBaseUrl).toBeUndefined();
  expect(state.havePerformedSettingsServiceMigration).toBe(true);
  expect(rows["aisettings.service"]).toBeUndefined();
  const settings = await readFile(
    join(directory, "User", "settings.json"),
    "utf8",
  );
  expect(settings).toContain("// keep my comment");
  expect(settings).toContain('"editor.fontSize": 17');
  expect(settings).not.toContain("old-secret");
  expect(settings).not.toContain("old:123");
  expect(settings).toContain('"cursor.general.disableHttp2": true');
  expect(settings).toContain('"cursor.general.disableHttp1SSE": false');
  expect(settings).toContain('"update.mode": "none"');
  expect(JSON.parse(rows["cursorai/serverConfig"]!)).toMatchObject({
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
  });
  expect((await stat(database())).mode & 0o777).toBe(0o600);
  expect(existsSync(join(directory, ".impact-launch-lock"))).toBe(false);
});

it("holds an exclusive launch lock through the scope and rejects a second launch before DB mutation", async () => {
  await run(
    Effect.gen(function* () {
      yield* prepareCursorProfile(directory, account, ["model"], noStock());
      expect(existsSync(join(directory, ".impact-launch-lock"))).toBe(true);
      const second = yield* Effect.exit(
        Effect.scoped(
          prepareCursorProfile(
            directory,
            { ...account, token: "wrong" },
            ["model"],
            noStock(),
          ),
        ),
      );
      expect(second._tag).toBe("Failure");
      expect(readRows()["cursorAuth/accessToken"]).toBe(account.token);
    }),
  );
  expect(existsSync(join(directory, ".impact-launch-lock"))).toBe(false);
  await run(prepareCursorProfile(directory, account, ["model"], noStock()));
});

it("recovers a dead CLI lock but refuses a live Electron SingletonLock", async () => {
  await writeFile(
    join(directory, ".impact-launch-lock"),
    JSON.stringify({ pid: 2147483647, nonce: "dead" }),
  );
  await run(prepareCursorProfile(directory, account, ["model"], noStock()));
  await symlink(`any-host-${process.pid}`, join(directory, "SingletonLock"));
  await expect(
    run(prepareCursorProfile(directory, account, ["model"], noStock())),
  ).rejects.toThrow("Cursor already owns");
});

it("does not treat a stale regular SingletonLock as a live Cursor", async () => {
  await writeFile(join(directory, "SingletonLock"), "stale-lock");
  expect(await run(cursorProfileInUse(directory))).toBe(false);
});

it("detects a running Cursor by its code.lock, which it writes instead of Chromium's SingletonLock", async () => {
  await writeFile(join(directory, "code.lock"), "2147483647");
  expect(await run(cursorProfileInUse(directory))).toBe(false);
  await run(prepareCursorProfile(directory, account, ["model"], noStock()));
  await writeFile(join(directory, "code.lock"), String(process.pid));
  expect(await run(cursorProfileInUse(directory))).toBe(true);
  await expect(
    run(prepareCursorProfile(directory, account, ["model"], noStock())),
  ).rejects.toThrow("Cursor already owns");
});

it("refuses stock profile and storage aliases without writing them", async () => {
  const home = process.env.HOME ?? process.env.USERPROFILE!;
  const stock =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Cursor")
      : process.platform === "win32"
        ? join(
            process.env.APPDATA ?? join(home, "AppData", "Roaming"),
            "Cursor",
          )
        : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor");
  await expect(
    run(prepareCursorProfile(stock, account, ["model"])),
  ).rejects.toThrow("normal Cursor profile");
  const outside = join(directory, "outside");
  await mkdir(outside);
  const profile = join(directory, "managed");
  await mkdir(profile);
  await symlink(outside, join(profile, "User"));
  await expect(
    run(prepareCursorProfile(profile, account, ["model"], noStock())),
  ).rejects.toThrow("must not link outside");
  expect(existsSync(join(outside, "globalStorage"))).toBe(false);
  expect(existsSync(join(profile, ".impact-launch-lock"))).toBe(false);
});

it("fails on malformed settings and releases its lock", async () => {
  await mkdir(join(directory, "User"));
  await writeFile(join(directory, "User", "settings.json"), "{ invalid ");
  await expect(
    run(prepareCursorProfile(directory, account, ["model"], noStock())),
  ).rejects.toThrow("settings.json is invalid");
  expect(existsSync(join(directory, ".impact-launch-lock"))).toBe(false);
});

it("resolves installed macOS bundle paths without running the app", async () => {
  const app = join(directory, "Cursor.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "MacOS", "Cursor"), "do not execute");
  await mkdir(
    join(app, "Contents", "Resources", "app", "out", "vs", "workbench"),
    { recursive: true },
  );
  await writeFile(
    join(
      app,
      "Contents",
      "Resources",
      "app",
      "out",
      "vs",
      "workbench",
      "workbench.desktop.main.js",
    ),
    "fixture",
  );
  expect(resolveCursorApp(join(app, "Contents", "MacOS", "Cursor"))).toBe(
    realpathSync(app),
  );
});

const writeRows = (path: string, rows: Record<string, string>) => {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB)");
    const insert = db.prepare("INSERT OR REPLACE INTO ItemTable VALUES (?,?)");
    for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  } finally {
    db.close();
  }
};
const rowsOf = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return Object.fromEntries(
      (db.prepare("SELECT key,value FROM ItemTable").all() as Array<{ key: string; value: string }>).map((row) => [
        row.key,
        row.value,
      ]),
    );
  } finally {
    db.close();
  }
};
const settingsOf = async (path: string) => {
  const text = await readFile(path, "utf8");
  return { text, value: parse(text, [], { allowTrailingComma: true }) as Record<string, unknown> };
};

it("copies the user's Cursor setup, keeps Impact-window edits and never touches Cursor's own state", async () => {
  const stock = join(directory, "stock");
  const user = join(stock, "User");
  const named = join(user, "profiles", "night");
  await mkdir(join(user, "globalStorage"), { recursive: true });
  await mkdir(join(user, "snippets"), { recursive: true });
  await mkdir(join(named, "globalStorage"), { recursive: true });
  const stockSettings =
    '{\n  // my theme\n  "workbench.colorTheme": "Tokyo Night",\n  "editor.fontSize": 14,\n  "http.proxy": "http://corp:8080",\n  "update.mode": "default",\n}\n';
  await writeFile(join(user, "settings.json"), stockSettings);
  await writeFile(join(user, "keybindings.json"), '[{ "key": "cmd+k", "command": "stock" }]');
  await writeFile(join(user, "snippets", "ts.json"), '{ "log": { "body": "console.log()" } }');
  await writeFile(
    join(user, "globalStorage", "storage.json"),
    JSON.stringify({
      userDataProfiles: [
        { location: "night", name: "tokionight" },
        { location: "../escape", name: "escape" },
      ],
      profileAssociations: { workspaces: { "file:///work/aura": "night" }, emptyWindows: {} },
      windowsState: { stock: true },
    }),
  );
  await writeFile(join(named, "settings.json"), '{ "workbench.colorTheme": "Night Owl" }');
  await writeFile(join(named, "extensions.json"), '[{ "identifier": { "id": "vira.vsc-vira-theme" } }]');
  const disabled = '[{"id":"ms-vscode.vscode-typescript-next"}]';
  writeRows(join(user, "globalStorage", "state.vscdb"), {
    "extensionsIdentifiers/disabled": disabled,
    "cursorAuth/accessToken": "stock-cursor-session",
    "composer.history": "stock-chats",
  });
  writeRows(join(named, "globalStorage", "state.vscdb"), { "extensionsIdentifiers/disabled": '[{"id":"night.only"}]' });
  await mkdir(join(directory, "User"), { recursive: true });
  await writeFile(join(directory, "User", "settings.json"), '{ "window.autoDetectColorScheme": true, "editor.wordWrap": "on" }');
  await writeFile(join(user, "settings.json"), stockSettings.replace("{\n", '{\n  "window.autoDetectColorScheme": false,\n'));

  await run(prepareCursorProfile(directory, account, ["model"], stock));

  const managed = join(directory, "User");
  const first = await settingsOf(join(managed, "settings.json"));
  expect(first.text).toContain("// my theme");
  expect(first.value).toMatchObject({
    "workbench.colorTheme": "Tokyo Night",
    "editor.fontSize": 14,
    // Shared keys follow Cursor on the first launch; Impact-only keys stay.
    "window.autoDetectColorScheme": false,
    "editor.wordWrap": "on",
    "update.mode": "none",
    "cursor.general.disableHttp2": true,
  });
  expect(first.value["http.proxy"]).toBeUndefined();
  expect(await readFile(join(managed, "keybindings.json"), "utf8")).toContain('"stock"');
  expect(await readFile(join(managed, "snippets", "ts.json"), "utf8")).toContain("console.log()");
  const storage = JSON.parse(await readFile(join(managed, "globalStorage", "storage.json"), "utf8"));
  expect(storage.userDataProfiles).toEqual([{ location: "night", name: "tokionight" }]);
  expect(storage.profileAssociations.workspaces).toEqual({ "file:///work/aura": "night" });
  expect(storage.windowsState).toBeUndefined();
  expect(existsSync(join(managed, "escape"))).toBe(false);
  expect((await settingsOf(join(managed, "profiles", "night", "settings.json"))).value).toMatchObject({
    "workbench.colorTheme": "Night Owl",
    "cursor.general.disableHttp2": true,
  });
  // A shared list stops either Cursor from deleting extensions only the other profile set lists.
  expect(realpathSync(join(managed, "profiles", "night", "extensions.json"))).toBe(
    realpathSync(join(named, "extensions.json")),
  );
  const rows = readRows();
  expect(rows["extensionsIdentifiers/disabled"]).toBe(disabled);
  expect(rows["cursorAuth/accessToken"]).toBe(account.token);
  expect(rows["composer.history"]).toBeUndefined();
  expect(rowsOf(join(managed, "profiles", "night", "globalStorage", "state.vscdb"))["extensionsIdentifiers/disabled"]).toBe(
    '[{"id":"night.only"}]',
  );

  // Edits in the Impact window survive; later changes in Cursor still arrive.
  const managedSettings = join(managed, "settings.json");
  await writeFile(
    managedSettings,
    (await readFile(managedSettings, "utf8")).replace('"editor.fontSize": 14', '"editor.fontSize": 20, "editor.tabSize": 8'),
  );
  await writeFile(join(managed, "keybindings.json"), '[{ "key": "cmd+j", "command": "impact" }]');
  await writeFile(
    join(user, "settings.json"),
    '{ "workbench.colorTheme": "Light", "editor.fontSize": 16, "window.autoDetectColorScheme": false }',
  );
  await writeFile(join(user, "keybindings.json"), '[{ "key": "cmd+k", "command": "stock-2" }]');
  await rm(join(user, "snippets", "ts.json"));
  writeRows(join(user, "globalStorage", "state.vscdb"), { "extensionsIdentifiers/disabled": "[]" });

  await run(prepareCursorProfile(directory, account, ["model"], stock));

  const second = await settingsOf(managedSettings);
  expect(second.value).toMatchObject({
    "workbench.colorTheme": "Light",
    "editor.fontSize": 20,
    "editor.tabSize": 8,
    "editor.wordWrap": "on",
    "update.mode": "none",
  });
  expect(await readFile(join(managed, "keybindings.json"), "utf8")).toContain('"impact"');
  expect(existsSync(join(managed, "snippets", "ts.json"))).toBe(false);
  expect(readRows()["extensionsIdentifiers/disabled"]).toBe("[]");

  // Cursor's own profile is only read.
  expect(rowsOf(join(user, "globalStorage", "state.vscdb"))["cursorAuth/accessToken"]).toBe("stock-cursor-session");
  expect(await readFile(join(named, "settings.json"), "utf8")).toBe('{ "workbench.colorTheme": "Night Owl" }');
  expect(JSON.parse(await readFile(join(user, "globalStorage", "storage.json"), "utf8")).windowsState).toEqual({
    stock: true,
  });
});

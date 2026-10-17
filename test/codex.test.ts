import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "smol-toml";

import { configureCodex } from "../src/clients/codex/Config.ts";
import { impactCodexAuth } from "../src/clients/codex/Auth.ts";
import { route } from "../src/clients/codex/Proxy.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { usage as fixtureUsage } from "./support/Impact.ts";

const environment = isolatedEnvironment();
const execFile = promisify(execFileCallback);
const usage = { ...fixtureUsage, currency: "USD" as const };

describe("impactCodexAuth session persistence", () => {
  it.effect("repairs deleted launch aliases referenced by an existing SQLite index", () =>
    Effect.gen(function* () {
      const source = environment.directory;
      const sqliteHome = join(source, "index");
      const oldHome = join(source, ".impact-old123");
      const rollout = join(oldHome, "sessions", "2026", "10", "09", "rollout-thread.jsonl");
      const content = '{"type":"session_meta","payload":{"id":"thread"}}\n';
      yield* Effect.promise(async () => {
        await mkdir(sqliteHome);
        await mkdir(join(source, "sessions", "2026", "10", "09"), { recursive: true });
        await writeFile(join(source, "sessions", "2026", "10", "09", "rollout-thread.jsonl"), content);
        await mkdir(oldHome);
        await rm(oldHome, { recursive: true });
        await writeFile(join(source, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
        const db = new DatabaseSync(join(sqliteHome, "state_5.sqlite"));
        try {
          db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
          db.prepare("INSERT INTO threads VALUES (?, ?)").run("thread", rollout);
        } finally { db.close(); }
      });
      for (let launch = 0; launch < 2; launch++) {
        yield* Effect.scoped(Effect.gen(function* () {
          const account = yield* impactCodexAuth(usage);
          yield* configureCodex("gpt-6.1-sol", { models: [] }, "https://127.0.0.1:1", account.directory);
          yield* Effect.promise(async () => {
            const db = new DatabaseSync(join(sqliteHome, "state_5.sqlite"), { readOnly: true });
            try {
              const row = db.prepare("SELECT rollout_path FROM threads WHERE id = 'thread'").get() as { rollout_path: string };
              expect(row.rollout_path).toBe(rollout);
              expect(await readFile(row.rollout_path, "utf8")).toBe(content);
            } finally { db.close(); }
          });
        }));
        yield* Effect.promise(async () => {
          expect(await readFile(rollout, "utf8")).toBe(content);
          expect((await readdir(oldHome)).sort()).toEqual(["archived_sessions", "sessions", "shell_snapshots"]);
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps SQLite rollout paths readable after exit and during a later launch", () =>
    Effect.gen(function* () {
      const sqlitePath = join(environment.directory, "state_5.sqlite");
      const content = '{"type":"session_meta","payload":{"id":"thread"}}\n';
      const first = yield* Effect.scoped(Effect.gen(function* () {
        const account = yield* impactCodexAuth(usage);
        yield* configureCodex("gpt-6.1-sol", { models: [] }, "https://127.0.0.1:1", account.directory);
        yield* Effect.promise(async () => {
          const directory = join(account.directory, "sessions", "2026", "10", "09");
          await mkdir(directory, { recursive: true });
          const rollout = join(directory, "rollout-thread.jsonl");
          await writeFile(rollout, content);
          const db = new DatabaseSync(sqlitePath);
          try {
            db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
            db.prepare("INSERT INTO threads VALUES (?, ?)").run("thread", rollout);
          } finally { db.close(); }
          // Also keep archived paths and snapshots referenced by rollouts alive.
          await writeFile(join(account.directory, "archived_sessions", "archived.jsonl"), content);
          await writeFile(join(account.directory, "shell_snapshots", "thread.sh"), "export TEST=1\n");
        });
        return account;
      }));
      const checkResume = () => Effect.promise(async () => {
        const db = new DatabaseSync(sqlitePath, { readOnly: true });
        try {
          const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("thread") as { rollout_path: string };
          expect(await readFile(row.rollout_path, "utf8")).toBe(content);
        } finally { db.close(); }
        expect(await readFile(join(first.directory, "archived_sessions", "archived.jsonl"), "utf8")).toBe(content);
        expect(await readFile(join(first.directory, "shell_snapshots", "thread.sh"), "utf8")).toBe("export TEST=1\n");
        expect((await readdir(first.directory)).sort()).toEqual(["archived_sessions", "sessions", "shell_snapshots"]);
      });
      yield* checkResume();
      yield* Effect.scoped(Effect.gen(function* () {
        const second = yield* impactCodexAuth(usage);
        expect(second.directory).not.toBe(first.directory);
        yield* checkResume();
      }));
      yield* checkResume();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("isolates overlapping launches and cleans up even when the client fails", () =>
    Effect.gen(function* () {
      const outer = yield* impactCodexAuth(usage);
      const otherUsage = { ...usage, account: { id: "other", email: "other@example.com" } };
      const failed = yield* Effect.scoped(Effect.gen(function* () {
        const inner = yield* impactCodexAuth(otherUsage);
        expect(inner.directory).not.toBe(outer.directory);
        return yield* Effect.fail(inner.directory);
      })).pipe(Effect.flip);
      if (typeof failed !== "string") return yield* failed;
      yield* Effect.promise(async () => {
        expect((await readdir(failed)).sort()).toEqual(["archived_sessions", "sessions", "shell_snapshots"]);
        const auth = JSON.parse(await readFile(join(outer.directory, "auth.json"), "utf8"));
        const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString());
        expect(claims.sub).toBe(usage.account.id);
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("route", () => {
  const prefix = "/nonce";
  const replies = { "/api/codex/accounts/check": { ok: true } };

  it("forwards only Codex model, response and usage paths under the prefix", () => {
    for (const path of ["/v1/models", "/v1/responses", "/v1/responses/compact", "/backend-api/codex/models?x=1"])
      assert.deepStrictEqual(route(`${prefix}${path}`, prefix, replies), { forward: path });
    for (const url of ["/v1/models", "/other/v1/models", `${prefix}/api/mcp`, `${prefix}/v1/modelsx`, prefix])
      assert.isUndefined(route(url, prefix, replies));
  });

  it("answers account endpoints locally", () => {
    assert.deepStrictEqual(route(`${prefix}/api/codex/accounts/check`, prefix, replies), { reply: { ok: true } });
    assert.isUndefined(route(`${prefix}/api/codex/accounts/check`, prefix));
  });
});

describe("configureCodex", () => {
  it.effect("repairs a cold WAL session index when launched under Bun", () =>
    Effect.gen(function* () {
      const sqlitePath = join(environment.directory, "state_1.sqlite");
      const rollout = join(environment.directory, ".impact-wal123", "sessions", "2026", "10", "09", "rollout.jsonl");
      yield* Effect.promise(async () => {
        await mkdir(join(environment.directory, "sessions", "2026", "10", "09"), { recursive: true });
        await writeFile(join(environment.directory, "sessions", "2026", "10", "09", "rollout.jsonl"), "fixture\n");
        const db = new DatabaseSync(sqlitePath);
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
        db.prepare("INSERT INTO threads VALUES (?, ?)").run("thread", rollout);
        db.close();
        await rm(`${sqlitePath}-wal`, { force: true });
        await rm(`${sqlitePath}-shm`, { force: true });
      });
      yield* Effect.promise(() => execFile("bun", [
        "--no-env-file",
        "-e",
        'import { Effect } from "effect"; import { NodeServices } from "@effect/platform-node"; import { restoreCodexSessionAliases } from "./src/clients/codex/Sessions.ts"; const source = process.argv[1]; const sqliteHome = process.argv[2]; await Effect.runPromise(restoreCodexSessionAliases(source, sqliteHome).pipe(Effect.provide(NodeServices.layer)));',
        environment.directory,
        environment.directory,
      ]));
      yield* Effect.promise(async () => {
        expect(await readFile(rollout, "utf8")).toBe("fixture\n");
        expect((await readdir(join(environment.directory, ".impact-wal123"))).sort()).toEqual([
          "archived_sessions",
          "sessions",
          "shell_snapshots",
        ]);
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("continues launching when a legacy session index cannot be read", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(join(environment.directory, "state_1.sqlite")));
      const profile = yield* configureCodex("gpt-6.1-sol", { models: [] }, "https://127.0.0.1:1/nonce");
      const written = parse(yield* Effect.promise(() => readFile(join(environment.directory, `${profile.name}.config.toml`), "utf8")));
      expect(written.model).toBe("gpt-6.1-sol");
      expect(written.sqlite_home).toBe(environment.directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a temporary profile over the user's config and removes it with the scope", () =>
    Effect.gen(function* () {
      const original =
        '# User settings\nmodel = "original"\n[features]\nvoice = true\n[mcp_servers.example]\ncommand = "server"\n';
      yield* Effect.promise(() => writeFile(join(environment.directory, "config.toml"), original));
      const profile = yield* configureCodex("gpt-6.1-sol", { models: [] }, "https://127.0.0.1:1/nonce").pipe(
        Effect.tap(({ name }) =>
          Effect.promise(async () => {
            const written = parse(await readFile(join(environment.directory, `${name}.config.toml`), "utf8"));
            expect(written).toMatchObject({
              model: "gpt-6.1-sol",
              model_provider: "impact",
              model_providers: {
                impact: {
                  name: "Impact",
                  base_url: "https://127.0.0.1:1/nonce/v1",
                  model_catalog_url: "https://127.0.0.1:1/nonce/v1/models",
                  wire_api: "responses",
                  requires_openai_auth: true,
                  supports_websockets: false,
                },
              },
              features: { voice: true, fast_mode: true, apps: false },
              mcp_servers: { example: { command: "server" } },
            });
          }),
        ),
        Effect.scoped,
      );
      expect(profile.overrides).toContain("features.fast_mode=true");
      expect(profile.overrides).toContain('model="gpt-6.1-sol"');
      expect(profile.overrides).toContain('model_provider="impact"');
      expect(profile.overrides).toContain("model_providers.impact.supports_websockets=false");
      assert.strictEqual(profile.overrides.filter((arg) => arg === "-c").length, profile.overrides.length / 2);
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "config.toml"), "utf8")),
        original,
      );
      const left = yield* Effect.promise(() => readdir(environment.directory));
      assert.deepStrictEqual(left, ["config.toml"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an invalid config.toml", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(join(environment.directory, "config.toml"), "model = "));
      const error = yield* Effect.flip(configureCodex("m", {}, "https://x").pipe(Effect.scoped));
      expect(error.message).toContain("invalid TOML");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

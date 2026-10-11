import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";

import { impactCodexAuth } from "../src/clients/codex/Auth.ts";
import { configureCodex } from "../src/clients/codex/Config.ts";
import { route } from "../src/clients/codex/Proxy.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { impactBody, key, usage as fixture } from "./support/Impact.ts";

const environment = isolatedEnvironment();

describe("route", () => {
  const prefix = "/nonce";
  const replies = { "/api/codex/accounts/check": { ok: true } };

  it("forwards only Codex's model, response, image and usage paths under the prefix", () => {
    for (const path of [
      "/v1/models",
      "/v1/responses",
      "/v1/responses/compact",
      "/backend-api/codex/models?x=1",
      "/v1/images/generations",
      "/backend-api/codex/images/edits",
      "/api/codex/usage",
    ])
      assert.deepStrictEqual(route(`${prefix}${path}`, prefix, replies), { forward: path });
    for (const url of [
      "/v1/models",
      "/other/v1/models",
      `${prefix}/api/mcp`,
      `${prefix}/v1/modelsx`,
      `${prefix}/v1/models/gpt-6.1-sol`,
      `${prefix}/v1/keys/self/revoke`,
      `${prefix}/v1/alpha/history/v2/list_windows`,
      prefix,
    ])
      assert.isUndefined(route(url, prefix, replies));
  });

  it("answers account endpoints locally", () => {
    assert.deepStrictEqual(route(`${prefix}/api/codex/accounts/check`, prefix, replies), { reply: { ok: true } });
    assert.isUndefined(route(`${prefix}/api/codex/accounts/check`, prefix));
  });
});

describe("configureCodex", () => {
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
      expect(profile.name).toMatch(/^impact-/);
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "config.toml"), "utf8")),
        original,
      );
      const left = yield* Effect.promise(() => readdir(environment.directory));
      assert.deepStrictEqual(left, ["config.toml"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a launch home's linked config.toml with the merged config, leaving the user's file", () =>
    Effect.gen(function* () {
      const original = '[mcp_servers.example]\ncommand = "server"\n';
      const home = join(environment.directory, ".impact-home");
      yield* Effect.promise(async () => {
        await writeFile(join(environment.directory, "config.toml"), original);
        await mkdir(home);
        await symlink(join(environment.directory, "config.toml"), join(home, "config.toml"));
      });
      yield* configureCodex("gpt-6.1-sol", { models: [] }, "https://127.0.0.1:1/nonce", home, "home").pipe(
        Effect.tap(() =>
          Effect.promise(async () => {
            const config = join(home, "config.toml");
            expect((await lstat(config)).isSymbolicLink()).toBe(false);
            expect((await stat(config)).mode & 0o777).toBe(0o600);
            expect(parse(await readFile(config, "utf8"))).toMatchObject({
              model_provider: "impact",
              model_providers: { impact: { base_url: "https://127.0.0.1:1/nonce/v1" } },
              chatgpt_base_url: "https://127.0.0.1:1/nonce",
              mcp_servers: { example: { command: "server" } },
            });
          }),
        ),
        Effect.scoped,
      );
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "config.toml"), "utf8")),
        original,
      );
      const error = yield* Effect.flip(
        configureCodex("m", {}, "https://x", environment.directory, "home").pipe(Effect.scoped),
      );
      expect(error.message).toContain("never rewrites");
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "config.toml"), "utf8")),
        original,
      );
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

describe("impactCodexAuth", () => {
  const usage = { ...fixture, currency: "USD" as const };
  const owner = (pid: number, host = hostname()) => JSON.stringify({ pid, host });

  it.effect("shares the user's threads, thread names and installation id with the launch home", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(join(environment.directory, "installation_id"), "installation"));
      const home = yield* impactCodexAuth(usage).pipe(
        Effect.tap(({ directory }) =>
          Effect.promise(async () => {
            for (const name of ["sessions", "rules", "generated_images", "session_index.jsonl", "installation_id"])
              expect(await readlink(join(directory, name))).toBe(join(environment.directory, name));
            await writeFile(join(directory, "session_index.jsonl"), '{"thread":"named"}\n', { flag: "a" });
            expect(JSON.parse(await readFile(join(directory, ".impact-owner"), "utf8"))).toEqual({
              pid: process.pid,
              host: hostname(),
            });
          }),
        ),
        Effect.scoped,
      );
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "session_index.jsonl"), "utf8")),
        '{"thread":"named"}\n',
      );
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "installation_id"), "utf8")),
        "installation",
      );
      const left = yield* Effect.promise(() => readdir(environment.directory));
      assert.isFalse(left.includes(home.directory.split("/").at(-1)!));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes one installation id for both homes when Codex has none yet", () =>
    Effect.gen(function* () {
      const linked = yield* impactCodexAuth(usage).pipe(
        Effect.flatMap(({ directory }) => Effect.promise(() => readFile(join(directory, "installation_id"), "utf8"))),
        Effect.scoped,
      );
      expect(linked).toMatch(/^[0-9a-f-]{36}$/);
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(environment.directory, "installation_id"), "utf8")),
        linked,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Live clock: a home's age is measured against the file system's real modification times.
  it.live("removes homes left by a dead launch and keeps live or recent ones", () =>
    Effect.gen(function* () {
      const dead = spawnSync("true").pid!;
      const sessions = join(environment.directory, "sessions");
      const homes = {
        dead: join(environment.directory, ".impact-dead00"),
        live: join(environment.directory, ".impact-live00"),
        elsewhere: join(environment.directory, ".impact-other0"),
        legacyOld: join(environment.directory, ".impact-Old123"),
        legacyNew: join(environment.directory, ".impact-New123"),
        models: join(environment.directory, ".impact-models-abc123"),
      };
      yield* Effect.promise(async () => {
        await mkdir(join(sessions, "thread"), { recursive: true });
        await writeFile(join(sessions, "thread", "rollout.jsonl"), "kept");
        for (const home of Object.values(homes)) await mkdir(home);
        await writeFile(join(homes.dead, ".impact-owner"), owner(dead));
        await symlink(sessions, join(homes.dead, "sessions"));
        await writeFile(join(homes.live, ".impact-owner"), owner(process.pid));
        await writeFile(join(homes.elsewhere, ".impact-owner"), owner(dead, "another-host"));
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        await utimes(homes.legacyOld, old, old);
        await utimes(homes.models, old, old);
      });
      yield* impactCodexAuth(usage).pipe(Effect.scoped);
      const left = yield* Effect.promise(() => readdir(environment.directory));
      for (const removed of [homes.dead, homes.legacyOld]) assert.notInclude(left, removed.split("/").at(-1));
      for (const kept of [homes.live, homes.elsewhere, homes.legacyNew, homes.models])
        assert.include(left, kept.split("/").at(-1));
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(sessions, "thread", "rollout.jsonl"), "utf8")),
        "kept",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("impact codex", () => {
  const fakeImpact = Effect.gen(function* () {
    const impact = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(impactBody(new URL(request.url ?? "/", "http://x").pathname)));
    });
    impact.listen(0, "127.0.0.1");
    yield* Effect.promise(() => once(impact, "listening"));
    yield* Effect.addFinalizer(() => Effect.sync(() => impact.close()));
    return `http://127.0.0.1:${(impact.address() as AddressInfo).port}`;
  });
  const homes = () =>
    readdir(environment.directory).then((names) => names.filter((name) => name.startsWith(".impact-")));

  it.live(
    "gives app-server its config in the launch home, never in its arguments",
    () =>
      Effect.gen(function* () {
        const baseUrl = yield* fakeImpact;
        const original = '[mcp_servers.example]\ncommand = "server"\n';
        yield* Effect.promise(() => writeFile(join(environment.directory, "config.toml"), original));
        // The fake client waits for stdin, so the launch home is there to inspect until it ends.
        const child = spawn("bun", ["--no-env-file", resolve("src/main.ts"), "codex", "app-server"], {
          env: {
            ...process.env,
            IMPACT_API_KEY: key,
            IMPACT_BASE_URL: baseUrl,
            IMPACT_CODEX_BIN: resolve("test/fixtures/client.mjs"),
            CLIENT_READ_STDIN: "1",
          },
          stdio: ["pipe", "pipe", "ignore"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
        const exited = once(child, "exit");
        const home = yield* Effect.promise(async () => {
          for (;;) {
            if (child.exitCode !== null) throw new Error(`impact exited with ${child.exitCode}`);
            for (const name of await homes()) {
              const config = await lstat(join(environment.directory, name, "config.toml")).catch(() => undefined);
              if (config?.isFile()) return join(environment.directory, name);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        });
        const config = join(home, "config.toml");
        expect((yield* Effect.promise(() => stat(home))).mode & 0o777).toBe(0o700);
        expect((yield* Effect.promise(() => stat(config))).mode & 0o777).toBe(0o600);
        const settings = parse(yield* Effect.promise(() => readFile(config, "utf8")));
        expect(settings).toMatchObject({ model_provider: "impact", mcp_servers: { example: { command: "server" } } });
        const proxyUrl = String(settings.chatgpt_base_url);
        expect(proxyUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/);
        expect(settings.model_providers).toMatchObject({ impact: { base_url: `${proxyUrl}/v1` } });
        child.stdin.end();
        const [code] = yield* Effect.promise(() => exited);
        expect(code).toBe(0);
        const body = JSON.parse(stdout);
        expect(body.args).toEqual(["app-server"]);
        expect(body.codexHome).toBe(home);
        assert.strictEqual(
          yield* Effect.promise(() => readFile(join(environment.directory, "config.toml"), "utf8")),
          original,
        );
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "removes the launch home when the terminal closes (SIGHUP)",
    () =>
      Effect.gen(function* () {
        const baseUrl = yield* fakeImpact;
        // The fake client waits for stdin, which stays open: Codex is running until the hangup.
        const child = spawn("bun", ["--no-env-file", resolve("src/main.ts"), "codex", "exec", "hello"], {
          env: {
            ...process.env,
            IMPACT_API_KEY: key,
            IMPACT_BASE_URL: baseUrl,
            IMPACT_CODEX_BIN: resolve("test/fixtures/client.mjs"),
            CLIENT_READ_STDIN: "1",
          },
          stdio: ["pipe", "ignore", "ignore"],
        });
        const exited = once(child, "exit");
        yield* Effect.promise(async () => {
          while ((await homes()).length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        });
        child.kill("SIGHUP");
        yield* Effect.promise(() => exited);
        assert.deepStrictEqual(yield* Effect.promise(homes), []);
      }).pipe(Effect.scoped),
    20_000,
  );
});

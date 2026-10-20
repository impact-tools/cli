import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { apiKey, baseUrl } from "../src/config/Connection.ts";
import {
  configDirectory,
  currentConnection,
  daemonConnection,
  readConnection,
  removeConnection,
  resolveEndpoint,
  saveConnection,
} from "../src/config/Credentials.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { key } from "./support/Impact.ts";

const environment = isolatedEnvironment();

describe("baseUrl", () => {
  it.effect("keeps only the origin and allows HTTP on loopback hosts", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* baseUrl("http://impactllm.localhost:4420/v1/"), "http://impactllm.localhost:4420");
      assert.strictEqual(yield* baseUrl("https://user:secret@impact.test/v1?x=1#y"), "https://impact.test");
      assert.strictEqual(yield* baseUrl("http://127.0.0.1:4420"), "http://127.0.0.1:4420");
    }),
  );

  it.effect.each(["http://example.com", "ftp://example.com", "example.com", ""])("rejects %j", (input) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(baseUrl(input));
      assert.strictEqual(error._tag, "CliError");
    }),
  );
});

describe("apiKey", () => {
  it.effect("trims input and rejects keys of the wrong shape", () =>
    Effect.gen(function* () {
      assert.strictEqual(Redacted.value(yield* apiKey(` ${key}\n`)), key);
      assert.strictEqual((yield* Effect.flip(apiKey("sk-imp-short"))).message, "Enter an Impact API key (sk-imp-…).");
    }),
  );
});

describe("credentials", () => {
  it("resolves a relative config directory before any daemon changes its working directory", () => {
    process.env.IMPACT_CONFIG_DIR = "./relative-impact-config";
    expect(configDirectory()).toBe(join(process.cwd(), "relative-impact-config"));
  });

  it.effect("stores an endpoint-bound key with private permissions and removes it on logout", () =>
    Effect.gen(function* () {
      const file = join(environment.directory, "credentials.json");
      assert.isUndefined(yield* readConnection);
      yield* saveConnection({ baseUrl: "https://impact.test", apiKey: Redacted.make(key) });
      expect(JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))).toEqual({
        baseUrl: "https://impact.test",
        apiKey: key,
      });
      assert.strictEqual((yield* Effect.promise(() => stat(file))).mode & 0o777, 0o600);
      assert.strictEqual((yield* currentConnection).baseUrl, "https://impact.test");

      process.env.IMPACT_BASE_URL = "https://another.test";
      expect((yield* Effect.flip(currentConnection)).message).toContain("different Impact endpoint");
      process.env.IMPACT_API_KEY = `sk-imp-${"B".repeat(43)}`;
      assert.strictEqual(Redacted.value((yield* currentConnection).apiKey), process.env.IMPACT_API_KEY);

      yield* removeConnection;
      assert.isUndefined(yield* readConnection);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("daemon credentials move from env bootstrap to saved login and stay signed out after logout", () =>
    Effect.gen(function* () {
      process.env.IMPACT_API_KEY = key;
      process.env.IMPACT_BASE_URL = "https://env.test";
      const state = { bootstrap: true };
      assert.strictEqual(Redacted.value((yield* daemonConnection(state)).apiKey), key);
      yield* saveConnection({ baseUrl: "https://saved.test", apiKey: Redacted.make(key) });
      assert.strictEqual((yield* daemonConnection(state)).baseUrl, "https://saved.test");
      assert.isFalse(state.bootstrap);
      yield* removeConnection;
      expect((yield* Effect.flip(daemonConnection(state))).message).toContain("Run impact login");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers --base-url, then IMPACT_BASE_URL, then the saved endpoint", () =>
    Effect.gen(function* () {
      const saved = { baseUrl: "https://saved.test", apiKey: Redacted.make(key) };
      assert.strictEqual(yield* resolveEndpoint(saved), "https://saved.test");
      assert.strictEqual(yield* resolveEndpoint(undefined), "https://api.impact-relay.com");
      process.env.IMPACT_BASE_URL = "https://env.test";
      assert.strictEqual(yield* resolveEndpoint(saved), "https://env.test");
      assert.strictEqual(yield* resolveEndpoint(saved, "https://flag.test/v1"), "https://flag.test");
    }),
  );

  it.effect("reports corrupt credentials but accepts an explicit endpoint and key", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.writeFile(join(environment.directory, "credentials.json"), "{")),
      );
      expect((yield* Effect.flip(currentConnection)).message).toContain("Run impact login");
      process.env.IMPACT_BASE_URL = "https://explicit.test";
      process.env.IMPACT_API_KEY = key;
      const connection = yield* currentConnection;
      assert.strictEqual(connection.baseUrl, "https://explicit.test");
      assert.strictEqual(Redacted.value(connection.apiKey), key);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

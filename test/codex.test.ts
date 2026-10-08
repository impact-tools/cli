import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import { configureCodex } from "../src/clients/codex/Config.ts";
import { route } from "../src/clients/codex/Proxy.ts";
import { isolatedEnvironment } from "./support/Environment.ts";

const environment = isolatedEnvironment();

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

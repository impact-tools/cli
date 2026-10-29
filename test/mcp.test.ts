import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { prepareClaude } from "../src/clients/claude/Prepare.ts";
import { route } from "../src/clients/codex/Proxy.ts";
import { prepareOpenCode } from "../src/clients/opencode/Prepare.ts";
import { enabledMcpServers, readMcpSettings, setMcpServers } from "../src/config/Mcp.ts";
import { claudeMcpConfig, codexMcpServers, mcpSteps, MCP_TOOLS } from "../src/setup/Mcp.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { connection, impactHttp, key } from "./support/Impact.ts";

const environment = isolatedEnvironment();
const services = Layer.mergeAll(NodeServices.layer, impactHttp());
const Json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Any));
const run = promisify(execFile);
const impact = (args: string[]) =>
  run("bun", ["--no-env-file", resolve("src/main.ts"), ...args], {
    env: { ...process.env, IMPACT_API_KEY: key, IMPACT_BASE_URL: connection.baseUrl },
  });

describe("MCP settings", () => {
  it.effect("start with nothing on, and turn servers on and off one by one", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readMcpSettings, { enabled: [], dismissed: [] });
      yield* setMcpServers(["firecrawl", "context7"], true);
      assert.deepStrictEqual((yield* readMcpSettings).enabled, ["context7", "firecrawl"]);
      yield* setMcpServers(["firecrawl"], false);
      assert.deepStrictEqual(yield* enabledMcpServers, ["context7"]);
      const saved = JSON.parse(yield* Effect.promise(() => readFile(join(environment.directory, "mcp.json"), "utf8")));
      assert.deepStrictEqual(saved, { enabled: ["context7"], dismissed: [] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("let IMPACT_MCP choose for one launch", () =>
    Effect.gen(function* () {
      yield* setMcpServers(["context7"], true);
      process.env.IMPACT_MCP = "";
      assert.deepStrictEqual(yield* enabledMcpServers, []);
      process.env.IMPACT_MCP = "firecrawl, nonsense";
      assert.deepStrictEqual(yield* enabledMcpServers, ["firecrawl"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("MCP in launches", () => {
  it.effect("gives Claude the enabled servers with a header helper, never the key", () =>
    Effect.gen(function* () {
      yield* setMcpServers(["context7"], true);
      const prepared = yield* prepareClaude({ executable: "claude", args: ["-p", "x"], connection });
      const index = prepared.args.indexOf("--mcp-config");
      assert.isAbove(index, 0);
      const config = yield* Schema.decodeEffect(Json)(prepared.args[index + 1]!);
      assert.deepStrictEqual(Object.keys(config.mcpServers), ["context7"]);
      assert.strictEqual(config.mcpServers.context7.url, `${connection.baseUrl}/mcp/context7`);
      assert.include(config.mcpServers.context7.headersHelper, "mcp-headers");
      assert.notInclude(prepared.args.join(" "), key);
      assert.deepStrictEqual(prepared.args.slice(-2), ["-p", "x"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("adds nothing to Claude while every server is off", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareClaude({ executable: "claude", args: [], connection });
      assert.notInclude(prepared.args, "--mcp-config");
    }).pipe(Effect.provide(services)),
  );

  it.effect("merges the servers over OpenCode's own inline MCP settings", () =>
    Effect.gen(function* () {
      yield* setMcpServers(["firecrawl"], true);
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { mine: { type: "local", command: ["x"] } } });
      const prepared = yield* prepareOpenCode({ executable: "opencode", args: [], connection });
      const settings = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
      assert.deepStrictEqual(Object.keys(settings.mcp), ["mine", "firecrawl"]);
      assert.deepStrictEqual(settings.mcp.firecrawl, {
        type: "remote",
        url: `${connection.baseUrl}/mcp/firecrawl`,
        oauth: false,
        headers: { Authorization: "Bearer {env:IMPACT_API_KEY}" },
      });
      assert.notInclude(prepared.env.OPENCODE_CONFIG_CONTENT!, key);
    }).pipe(Effect.provide(services)),
  );

  it("points Codex at the proxy, which forwards the MCP paths with the key", () => {
    assert.deepStrictEqual(codexMcpServers(["context7"], "https://127.0.0.1:1/p"), {
      context7: { url: "https://127.0.0.1:1/p/mcp/context7" },
    });
    assert.deepStrictEqual(route("/p/mcp/firecrawl", "/p"), { forward: "/mcp/firecrawl" });
    assert.isUndefined(route("/p/mcp/other", "/p"));
  });

  it("builds Claude's config for several servers at one origin", () => {
    assert.deepStrictEqual(Object.keys(claudeMcpConfig(["context7", "firecrawl"], "https://x", "h").mcpServers), [
      "context7",
      "firecrawl",
    ]);
  });
});

describe("manual MCP setup", () => {
  it.each(MCP_TOOLS)("%s gets steps that name every server and parse", (tool) => {
    const steps = mcpSteps(tool, ["context7", "firecrawl"], { models: [], apiKey: key, platform: "unix" });
    const text = JSON.stringify(steps);
    for (const path of ["/mcp/context7", "/mcp/firecrawl"]) assert.include(text, path);
    for (const step of steps) if (step.kind === "code" && step.language === "json") JSON.parse(step.code);
  });
});

describe("impact mcp", () => {
  it("turns servers on, lists them and refuses an unknown one", async () => {
    await impact(["mcp", "enable", "context7"]);
    const listed = await impact(["mcp", "list"]);
    assert.include(listed.stdout, "context7: on");
    assert.include(listed.stdout, "firecrawl: off");
    const error = await impact(["mcp", "enable", "nope"]).catch((failure: { stderr: string }) => failure);
    assert.include("stderr" in error ? error.stderr : "", "Unknown MCP server nope");
    await impact(["mcp", "disable", "context7"]);
    assert.include((await impact(["mcp", "list"])).stdout, "context7: off");
  });
});

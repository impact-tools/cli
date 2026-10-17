import type { AddressInfo } from "node:net";

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { version } from "../package.json";
import { isolatedEnvironment } from "./support/Environment.ts";
import { impactBody, key } from "./support/Impact.ts";

// End-to-end: the real entry point and a fake client, which prints what it received as JSON.
const fixture = resolve("test/fixtures/client.mjs");
const entry = resolve("src/main.ts");
const run = promisify(execFile);
const environment = isolatedEnvironment();
let endpoint = "";
let server: Server;
let requests: string[];
let detailedStatus: boolean;

beforeEach(async () => {
  requests = [];
  detailedStatus = false;
  server = createServer((request, response) => {
    requests.push(new URL(request.url ?? "/", "http://x").pathname);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(impactBody(new URL(request.url ?? "/", "http://x").pathname)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  if (!detailedStatus) {
    expect(requests).not.toContain("/v1/usage/spend");
  }
  server.closeAllConnections();
  server.close();
});

const impact = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  detailedStatus ||= args[0] === "status" && !args.includes("--claude");
  return run("bun", ["--no-env-file", entry, ...args], {
    env: { ...process.env, IMPACT_API_KEY: key, IMPACT_BASE_URL: endpoint, ...env },
  });
};

describe("impact", () => {
  it("shows only the sign-in action on the guest landing", async () => {
    const result = await impact([], { IMPACT_API_KEY: "", FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout).toContain("Sign in to continue");
    expect(result.stdout).toContain("Connect your Impact account to launch coding clients.");
    expect(result.stdout).toContain("impact login");
    for (const command of [
      "claude",
      "codex",
      "cursor",
      "kilo",
      "opencode",
      "proxy",
      "status",
      "logout",
      "doctor",
      "helper",
      "auth",
    ])
      expect(result.stdout).not.toContain(`impact ${command}`);
    for (const hidden of ["Start a client", "Diagnostics", "--completions", "--log-level", "FLAGS", "status-line"])
      expect(result.stdout).not.toContain(hidden);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).toBe("");
  });

  it("shows the account balance and compact grouped actions on the authenticated landing", async () => {
    const result = await impact([], { FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout).toContain("ada@example.com");
    expect(result.stdout).toContain("$14.845 USD");
    expect(result.stdout).not.toContain("Sign in to continue");
    expect(result.stdout).not.toContain("impact login");
    expect(result.stdout).not.toContain("Coding clients through Impact LLM");
    expect(result.stdout.indexOf("ada@example.com")).toBeLessThan(result.stdout.indexOf("Start a client"));
    expect(result.stdout.indexOf("$14.845 USD")).toBeLessThan(result.stdout.indexOf("Start a client"));
    for (const group of ["Start a client", "Account", "Diagnostics"]) expect(result.stdout).toContain(group);
    for (const command of ["claude", "codex", "kilo", "opencode", "status", "logout", "doctor"])
      expect(result.stdout).toContain(`impact ${command}`);
    expect(result.stdout).toContain("impact --help");
    expect(result.stdout.match(/--[a-z][a-z-]*/g)).toEqual(["--help"]);
    for (const hidden of ["--completions", "--log-level", "FLAGS", "helper", "auth token", "status-line"])
      expect(result.stdout).not.toContain(hidden);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).toBe("");
  });

  it("keeps authenticated landing actions available when the balance request fails", async () => {
    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporarily unavailable" }));
    });
    const result = await impact([]);
    expect(result.stdout).toContain("Balance unavailable · impact status");
    for (const command of ["claude", "codex", "kilo", "opencode", "status", "logout", "doctor"])
      expect(result.stdout).toContain(`impact ${command}`);
    expect(result.stdout).not.toContain("Sign in to continue");
    expect(result.stdout).not.toContain("impact login");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).toBe("");
  });

  it("does not fetch the account when showing explicit help", async () => {
    let requests = 0;
    server.on("request", () => {
      requests += 1;
    });
    const result = await impact(["--help"]);
    expect(result.stdout).toContain("GLOBAL FLAGS");
    expect(result.stdout).toContain("--completions");
    expect(result.stderr).toBe("");
    expect(requests).toBe(0);
  });

  it("prints only the plain version when output is redirected", async () => {
    const result = await impact(["--version"], { FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout).toBe(`impact v${version}\n`);
    expect(result.stderr).toBe("");
  });

  it("emits a usable Bash completion script without branding or terminal controls", async () => {
    const result = await impact(["--completions", "bash"], { FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout.startsWith("###-begin-impact-completions-###\n")).toBe(true);
    expect(result.stdout).toContain("complete -F _impact impact\n");
    expect(result.stdout.trimEnd().endsWith("###-end-impact-completions-###")).toBe(true);
    expect(result.stdout).not.toContain("Impact LLM");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).toBe("");
  });

  it.each(["helper", "auth"])("prints the exact key for %s token without decoration", async (command) => {
    const result = await impact([command, "token"], { FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout).toBe(`${key}\n`);
    expect(result.stderr).toBe("");
  });

  it("repairs corrupt credentials with key-stdin login and never echoes the key", async () => {
    await writeFile(join(environment.directory, "credentials.json"), "{");
    const pending = run("bun", ["--no-env-file", entry, "login", "--key-stdin", "--base-url", endpoint], {
      env: { ...process.env, IMPACT_API_KEY: "", FORCE_COLOR: "3", TERM: "xterm-256color" },
    });
    pending.child.stdin!.end(`${key}\n`);
    const login = await pending;
    expect(login.stdout).toBe(`Signed in to ${endpoint}. 2 models available.\n`);
    expect(login.stdout + login.stderr).not.toContain(key);
    expect(login.stderr).toBe("");

    const saved = await impact(["helper", "token"], { IMPACT_API_KEY: "" });
    expect(saved.stdout).toBe(`${key}\n`);
    expect(saved.stderr).toBe("");

    const logout = await impact(["logout"]);
    expect(logout.stdout).toBe("Removed the saved Impact login. Manage or revoke API keys in the web app.\n");
    expect(logout.stderr).toBe("");
    await expect(impact(["helper", "token"], { IMPACT_API_KEY: "" })).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Run impact login, or set IMPACT_API_KEY.\n",
    });
  });

  it("shows the wallet, held and available balances with weekly spending", async () => {
    const result = await impact(["status"], { FORCE_COLOR: "3", TERM: "xterm-256color" });
    expect(result.stdout).toBe(
      `Impact · ada@example.com · $14.845 USD\nHeld: $2.5 USD\nAvailable: $12.345 USD\nEndpoint: ${endpoint}\n\n` +
        "Spend - last 7 days\nTotal: $3.13 USD\nSonnet 5.5: $2.00 USD\nGPT 6.1: $1.13 USD\n",
    );
    expect(requests).toEqual(["/v1/usage", "/v1/usage/spend"]);
    expect(result.stderr).toBe("");
  });

  it.each([404, 503, "malformed"] as const)("preserves the wallet when spending returns %s", async (failure) => {
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      if (path === "/v1/usage/spend") {
        response.writeHead(typeof failure === "number" ? failure : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ invalid: true }));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(impactBody(path)));
      }
    });
    const result = await impact(["status"]);
    expect(result.stdout).toContain("Impact · ada@example.com · $14.845 USD");
    expect(result.stdout).toContain("Held: $2.5 USD");
    expect(result.stdout).toContain("Available: $12.345 USD");
    expect(result.stdout).toContain("Spending data unavailable");
    expect(result.stdout).not.toContain("Total: $0.00 USD");
    expect(result.stderr).toBe("");
  });

  it("preserves the wallet when spending times out", async () => {
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      if (path === "/v1/usage/spend") return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(impactBody(path)));
    });
    const result = await impact(["status"]);
    expect(result.stdout).toContain("Impact · ada@example.com · $14.845 USD");
    expect(result.stdout).toContain("Spending data unavailable");
    expect(result.stdout).not.toContain("Total: $0.00 USD");
    expect(result.stderr).toBe("");
  }, 20_000);

  it.each([
    [{ balance: "12.345" }, "12.345"],
    [{ balance: "0", reserved: "10", total: "3" }, "3"],
    [{ balance: "7", reserved: "10", total: "0" }, "0"],
  ] as const)("uses the wallet total in status with credits %j", async (credits, total) => {
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(path === "/v1/usage" ? { currency: "USD", credits } : impactBody(path)));
    });
    const result = await impact(["status"]);
    expect(result.stdout).toContain(`Impact · ${endpoint} · $${total} USD`);
    expect(result.stdout).toContain(`Available: $${credits.balance} USD`);
    if (!("reserved" in credits)) expect(result.stdout).not.toContain("Held:");
  });

  it.each([
    ["status", "--claude"],
    ["helper", "status-line"],
  ])("keeps %j offline", async (...args) => {
    const result = await impact(args, { IMPACT_CLAUDE_STATUS_FILE: "" });
    expect(result.stdout).toBe("");
    expect(requests).toEqual([]);
  });

  it("retains plain doctor output for both installed and missing clients", async () => {
    const missing = join(environment.directory, "missing-client");
    const result = await impact(["doctor"], {
      IMPACT_CLAUDE_BIN: fixture,
      IMPACT_ANTIGRAVITY_BIN: missing,
      IMPACT_CODEX_BIN: missing,
      IMPACT_CURSOR_BIN: missing,
      IMPACT_KILO_BIN: fixture,
      IMPACT_OPENCODE_BIN: missing,
      FORCE_COLOR: "3",
      TERM: "xterm-256color",
    });
    expect(result.stdout).toBe(
      `Impact: ${endpoint}\nModels: 2\nantigravity: not installed\nclaude: ${fixture}\ncodex: not installed\ncursor: not installed\nkilo: ${fixture}\nopencode: not installed\n`,
    );
    expect(result.stderr).toBe("");
  });

  const cursorEnv = (extra: NodeJS.ProcessEnv = {}) => ({
    IMPACT_CURSOR_BIN: fixture,
    IMPACT_CURSOR_APP_DIR: resolve("test/fixtures/cursor-app"),
    ...extra,
  });
  /** The detached editor writes its output to the profile log; wait until it has printed its report. */
  const cursorReport = async (directory: string) => {
    for (let attempt = 0; attempt < 1200; attempt++) {
      try {
        return JSON.parse(await readFile(join(directory, "impact-cursor.log"), "utf8"));
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    throw new Error("Cursor did not report.");
  };

  // GitHub-hosted runners do not provide the Desktop CONNECT/HTTP2 stack this mock exercises.
  it.skipIf(process.env.CI === "true").each([false, true])("opens Cursor through the running background proxy (custom profile=%s)", async (custom) => {
    const directory = join(environment.directory, custom ? "custom-profile" : "cursor/profile");
    const env = cursorEnv(custom ? { IMPACT_CURSOR_USER_DATA_DIR: directory } : {});
    const setup = await impact(["proxy", "setup"], env);
    expect(setup.stdout).toContain(`Cursor CA: ${join(environment.directory, "proxy", "ca.pem")}`);
    expect(setup.stdout).toContain(`Codex CA: ${join(environment.directory, "proxy", "codex-ca.pem")}`);
    expect(setup.stdout).toMatch(/Cursor SPKI pin: sha256\/[A-Za-z0-9+/]{43}=/);
    expect(setup.stdout).toContain("CA private keys: Not stored");
    // Without a terminal, setup prints the next step instead of asking.
    expect(setup.stdout).toContain("Next: impact proxy start");
    expect(setup.stdout).not.toMatch(/[0-9a-f]{64}/);
    const config = JSON.parse(await readFile(join(environment.directory, "proxy", "config.json"), "utf8"));
    expect(setup.stdout).not.toContain(config.codex.prefix);
    for (const name of ["config.json", "proxy.key", "ca.pem", "proxy.pem", "codex.key", "codex-ca.pem", "codex.pem"])
      expect((await stat(join(environment.directory, "proxy", name))).mode & 0o777).toBe(0o600);
    try {
      expect((await impact(["proxy", "start"], env)).stdout).toContain("Started in the background.");
      // The proxy checks nothing when it starts; only the start summary reads the account name.
      // Cursor support loads on its first request.
      expect(requests).toEqual(["/v1/usage"]);

      const result = await impact(["cursor", "--new-window", "a path with spaces"], { ...env, VSCODE_IPC_HOOK_CLI: "existing-cursor-ipc" });
      expect(result.stdout).toBe("");
      const body = await cursorReport(directory);
      expect(body.args).toEqual([
        "--user-data-dir",
        directory,
        "--disable-http2",
        expect.stringMatching(/^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/),
        `--proxy-server=http://127.0.0.1:${config.port}`,
        "--new-window",
        "a path with spaces",
      ]);
      expect(body.args.join(" ")).not.toContain(key);
      expect(body.key).toBeUndefined();
      expect(body.cursorIpc).toBeUndefined();
      expect(body.cursorModels.models.map((model: { name: string }) => model.name)).toEqual([
        "claude-sonnet-5-5",
        "gpt-6.1-sol",
      ]);
      expect(body.cursorProfile).toEqual({ email: "Impact · ada@example.com", membership: "pro", tokenIsImpactKey: false });
      expect(body.cursorCertificate).toBe(join(environment.directory, "proxy", "ca.pem"));
      expect(new URL(body.cursorProxy).port).toBe(String(config.port));
      // The launch has handed the profile to the editor; no Impact process keeps it locked.
      await expect(stat(join(directory, ".impact-launch-lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(requests.sort()).toEqual(["/v1/models", "/v1/models", "/v1/usage", "/v1/usage"]);
      const status = await impact(["proxy", "status"], env);
      expect(status.stdout).toContain("Account: ada@example.com");
      expect(status.stdout).toContain(`Cursor proxy: 127.0.0.1:${config.port}`);
      expect(status.stdout).toContain("Cursor models: 2");
      await expect(impact(["cursor", "."], { ...env, IMPACT_API_KEY: `sk-imp-${"B".repeat(43)}` })).rejects.toMatchObject({
        code: 1,
        stderr: "The Impact proxy uses a different Impact login. Restart it from this shell: impact proxy restart.\n",
      });
    } finally {
      await impact(["proxy", "stop"], env);
    }
    await expect(impact(["cursor", "."], env)).rejects.toMatchObject({
      code: 1,
      stderr: "The Impact proxy is not running. Start it with impact proxy start.\n",
    });
  }, 120_000);

  it("requires the proxy setup before opening Cursor", async () => {
    await expect(impact(["cursor", "."], cursorEnv())).rejects.toMatchObject({
      code: 1,
      stderr: "The Impact proxy is not set up. Run impact proxy setup, then impact proxy start.\n",
    });
    expect((await impact(["proxy"], cursorEnv())).stdout).toBe("Not set up. Run impact proxy setup.\n");
    expect(requests).toEqual([]);
  });

  it("keeps a relative config directory stable when the daemon changes cwd", async () => {
    const env = { IMPACT_CONFIG_DIR: relative(process.cwd(), environment.directory), IMPACT_API_KEY: "" };
    await impact(["proxy", "setup"], env);
    expect(await stat(join(environment.directory, "proxy", "config.json"))).toBeTruthy();
    const config = JSON.parse(await readFile(join(environment.directory, "proxy", "config.json"), "utf8"));
    await impact(["proxy", "start"], env);
    let stopped = false;
    try {
      expect((await impact(["proxy", "status"], env)).stdout).toContain("State: Running · PID");
      const shutdown = (authorization?: string) => new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: config.port,
          path: "/impact/shutdown",
          method: "POST",
          ...(authorization ? { headers: { "proxy-authorization": authorization } } : {}),
        }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); });
        request.once("error", reject);
        request.end();
      });
      expect(await shutdown()).toBe(407);
      expect((await impact(["proxy", "status"], env)).stdout).toContain("State: Running · PID");
      expect(await shutdown(`Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`)).toBe(202);
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await impact(["proxy", "status"], env)).stdout.includes("Stopped.")) {
          stopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(stopped).toBe(true);
    } finally {
      if (!stopped) await impact(["proxy", "stop"], env);
    }
    expect((await impact(["proxy", "status"], env)).stdout).toContain("Stopped.");
  }, 60_000);

  it("passes Cursor help through offline and rejects flags that bypass its managed connection", async () => {
    const result = await impact(["cursor", "--help"], { IMPACT_API_KEY: "", IMPACT_CURSOR_BIN: fixture });
    expect(JSON.parse(result.stdout).args).toEqual(["--help"]);
    expect(requests).toEqual([]);
    await expect(impact(["cursor", "--reuse-window"], { IMPACT_CURSOR_BIN: fixture })).rejects.toMatchObject({
      code: 1,
      stderr: "Impact supplies Cursor's backend and profile. Use IMPACT_CURSOR_USER_DATA_DIR to select a profile.\n",
    });
    const remote = join(environment.directory, ".cursor-server", "bin", "cursor");
    await mkdir(join(remote, ".."), { recursive: true });
    await symlink(fixture, remote);
    await expect(impact(["cursor", "."], { IMPACT_CURSOR_BIN: remote })).rejects.toMatchObject({
      code: 1,
      stderr:
        "Run impact cursor on the computer with Cursor Desktop installed; the remote CLI cannot configure Desktop Tab.\n",
    });
    expect(requests).toEqual([]);
  });

  it("launches Kilo through Impact with its full model catalog and preserves client arguments and settings", async () => {
    const original = '// User Kilo settings\n{"mcp":{"example":{"type":"local","command":["server"]}}}\n';
    const settingsPath = join(environment.directory, "kilo.jsonc");
    await writeFile(settingsPath, original);
    const args = ["run", "--model", "impact/claude-sonnet-5-5", "--format", "json", "a prompt with spaces"];
    const result = await impact(["kilo", ...args], {
      IMPACT_KILO_BIN: fixture,
      KILO_CONFIG: settingsPath,
      KILO_CONFIG_CONTENT: JSON.stringify({
        permission: { bash: "ask" },
        mcp: { inline: { type: "local", command: ["tool"] } },
      }),
    });
    const body = JSON.parse(result.stdout);
    expect(body.args).toEqual(args);
    expect(body.args.join(" ")).not.toContain(key);
    expect(JSON.stringify(body.kiloConfig)).not.toContain(key);
    expect(body.key).toBe(key);
    expect(body.kiloConfig).toMatchObject({
      model: "impact/gpt-6.1-sol",
      small_model: "impact/gpt-6.1-sol",
      enabled_providers: ["impact"],
      permission: { bash: "ask" },
      mcp: { inline: { type: "local", command: ["tool"] } },
      provider: {
        impact: {
          npm: "@ai-sdk/openai-compatible",
          name: "Impact",
          env: ["IMPACT_API_KEY"],
          options: { baseURL: `${endpoint}/v1`, apiKey: "{env:IMPACT_API_KEY}" },
          whitelist: ["claude-sonnet-5-5", "gpt-6.1-sol"],
          models: {
            "gpt-6.1-sol": {
              id: "gpt-6.1-sol",
              name: "GPT 6.1",
              tool_call: true,
              reasoning: true,
              limit: { context: 272_000, output: 128_000 },
              cost: { input: 0.3, output: 2.4, cache_read: 0.03, cache_write: 0 },
            },
          },
        },
      },
    });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("launches OpenCode through Impact with only the advertised reasoning variants", async () => {
    const original =
      '{"$schema":"https://opencode.ai/config.json","mcp":{"example":{"type":"local","command":["server"]}}}\n';
    const settingsPath = join(environment.directory, "opencode.json");
    await writeFile(settingsPath, original);
    const args = ["run", "--model", "impact/claude-sonnet-5-5", "--variant", "max", "a prompt with spaces"];
    const result = await impact(["opencode", ...args], {
      IMPACT_OPENCODE_BIN: fixture,
      OPENCODE_CONFIG: settingsPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "ask" } }),
    });
    const body = JSON.parse(result.stdout);
    expect(body.args).toEqual(args);
    expect(body.kiloConfig).toBeUndefined();
    expect(JSON.stringify(body.openCodeConfig)).not.toContain(key);
    expect(body.key).toBe(key);
    expect(body.openCodeConfig).toMatchObject({
      model: "impact/gpt-6.1-sol",
      enabled_providers: ["impact"],
      permission: { bash: "ask" },
      provider: {
        impact: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${endpoint}/v1`, apiKey: "{env:IMPACT_API_KEY}" },
          whitelist: ["claude-sonnet-5-5", "gpt-6.1-sol"],
          models: {
            "claude-sonnet-5-5": {
              variants: {
                none: { reasoningEffort: "none" },
                minimal: { disabled: true },
                high: { reasoningEffort: "high" },
                xhigh: { disabled: true },
                max: { reasoningEffort: "max" },
              },
            },
          },
        },
      },
    });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("forwards Kilo help without requiring an Impact connection and preserves its exit code", async () => {
    const result = await run("bun", ["--no-env-file", entry, "kilo", "--help"], {
      env: { ...process.env, IMPACT_KILO_BIN: fixture, IMPACT_API_KEY: "", IMPACT_BASE_URL: "http://invalid.test" },
    });
    expect(JSON.parse(result.stdout).args).toEqual(["--help"]);
    await expect(
      impact(["kilo", "models", "impact"], {
        IMPACT_KILO_BIN: fixture,
        CLIENT_EXIT: "17",
      }),
    ).rejects.toMatchObject({ code: 17 });
  });

  it("prints framework help without login and forwards native help to the installed client", async () => {
    const root = await run("bun", ["--no-env-file", entry, "--help"], { env: process.env });
    for (const heading of ["Start a client:", "Account:", "Diagnostics:", "GLOBAL FLAGS"])
      expect(root.stdout).toContain(heading);
    expect(root.stdout).toContain("--completions");
    expect(root.stdout).not.toContain("helper");
    const native = await run("bun", ["--no-env-file", entry, "claude", "--help"], {
      env: { ...process.env, IMPACT_CLAUDE_BIN: fixture },
    });
    expect(JSON.parse(native.stdout).args).toEqual(["--help"]);
  });

  it("prints one line and exits 1 for expected failures", async () => {
    await expect(impact(["status"], { IMPACT_BASE_URL: "http://example.com" })).rejects.toMatchObject({
      code: 1,
      stderr: "Use an HTTPS Impact URL, or HTTP on localhost for development.\n",
    });
    await expect(impact(["status"], { IMPACT_API_KEY: "" })).rejects.toMatchObject({
      code: 1,
      stderr: "Run impact login, or set IMPACT_API_KEY.\n",
    });
  });

  it("passes Claude flags and stdin through and gives the key to the helper, not argv", async () => {
    const child = spawn("bun", ["--no-env-file", entry, "claude", "-p", "a prompt with spaces", "--", "literal"], {
      env: {
        ...process.env,
        IMPACT_CLAUDE_BIN: fixture,
        IMPACT_API_KEY: key,
        IMPACT_BASE_URL: endpoint,
        CLIENT_READ_STDIN: "1",
        CLIENT_STATUS_INPUT: "{}",
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stdin.end("context from stdin\n");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    const body = JSON.parse(output);
    expect(body.args.slice(2)).toEqual(["-p", "a prompt with spaces", "--", "literal"]);
    expect(body.args.join(" ")).not.toContain(key);
    expect(body.helperToken).toBe(key);
    expect(body.status).toBe("Impact · ada@example.com · $14.845 USD\n");
    expect(body.input).toBe("context from stdin\n");
  });

  it("launches clients from the supplied workspace when using the dev script", async () => {
    const workspace = environment.directory;
    const result = await run("bun", ["run", "--cwd", resolve("."), "dev", "claude", "-p", "hello"], {
      cwd: workspace,
      env: {
        ...process.env,
        IMPACT_LAUNCH_CWD: workspace,
        IMPACT_CLAUDE_BIN: fixture,
        IMPACT_API_KEY: key,
        IMPACT_BASE_URL: endpoint,
      },
    });
    expect(await realpath(JSON.parse(result.stdout).cwd)).toBe(await realpath(workspace));
  });

  it("runs Codex through the background proxy with an isolated home, keeping the user's files and its exit code", async () => {
    // The proxy starts without a login and reads the saved one when Codex first needs it.
    const signedOut = { IMPACT_API_KEY: "" };
    await impact(["proxy", "setup"], signedOut);
    expect((await impact(["proxy", "start"], signedOut)).stdout).toContain("Account: Not signed in · impact login");
    try {
      await writeFile(join(environment.directory, "credentials.json"), JSON.stringify({ baseUrl: endpoint, apiKey: key }), { mode: 0o600 });
      const config = JSON.parse(await readFile(join(environment.directory, "proxy", "config.json"), "utf8"));
      const codexUrl = `https://127.0.0.1:${config.codex.port}${config.codex.prefix}`;
      await runCodex(codexUrl);
      const ca = await readFile(join(environment.directory, "proxy", "codex-ca.pem"));
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((done, reject) => {
          const call = httpsRequest(codexUrl + path, { ca }, (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => done({ status: response.statusCode!, body }));
          });
          call.on("error", reject);
          call.end();
        });
      const models = await get("/v1/models");
      expect(models.status).toBe(200);
      expect(JSON.parse(models.body).data.map((model: { id: string }) => model.id)).toEqual(["claude-sonnet-5-5", "gpt-6.1-sol"]);
      expect(JSON.parse((await get("/api/codex/accounts/check")).body).default_account_id).toBe("ada");
      expect((await get("/v1/other")).status).toBe(404);
    } finally {
      await impact(["proxy", "stop"]);
    }
  });

  it("launches stock Antigravity through the shared daemon and restores its runtime after restart", async () => {
    const app = join(environment.directory, "Antigravity");
    const resources = join(app, "resources");
    await mkdir(join(resources, "bin"), { recursive: true });
    const executable = join(app, "antigravity");
    const languageServer = join(resources, "bin", "language_server");
    await copyFile(resolve("test/fixtures/antigravity-desktop.mjs"), executable);
    await copyFile(resolve("test/fixtures/antigravity-language-server.mjs"), languageServer);
    await chmod(executable, 0o700); await chmod(languageServer, 0o700);
    const pkg = Buffer.from(JSON.stringify({ version: "2.21.1" }));
    const header = Buffer.from(JSON.stringify({ files: { "package.json": { offset: "0", size: pkg.length } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
    const archive = Buffer.concat([prefix, header, pkg]);
    await writeFile(join(resources, "app.asar"), archive);
    const profile = join(environment.directory, "original-profile"); await mkdir(profile);
    await writeFile(join(profile, "settings.json"), '{"theme":"original"}');
    const env = { IMPACT_ANTIGRAVITY_BIN: executable };
    await expect(impact(["antigravity"], env)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("impact proxy setup") });
    const signedOut = { IMPACT_API_KEY: "", IMPACT_ANTIGRAVITY_BIN: "/missing", IMPACT_CODEX_BIN: "/missing", IMPACT_CURSOR_BIN: "/missing" };
    await impact(["proxy", "setup"], signedOut);
    await impact(["proxy", "start"], signedOut);
    try {
      expect(requests).toEqual([]);
      await writeFile(join(environment.directory, "credentials.json"), JSON.stringify({ baseUrl: endpoint, apiKey: key }), { mode: 0o600 });
      await impact(["antigravity", `--user-data-dir=${profile}`, "--native-flag"], env);
      const log = join(environment.directory, "proxy", "antigravity-desktop.log");
      let desktop: any;
      await expect.poll(async () => { try { desktop = JSON.parse(await readFile(log, "utf8")); return !!desktop.devUrl; } catch { return false; } }).toBe(true);
      expect(desktop.args).toEqual([expect.stringMatching(/^--ignore-certificate-errors-spki-list=/), `--user-data-dir=${profile}`, "--native-flag"]);
      expect(desktop.impactKey).toBeUndefined();
      expect(desktop.devUrl).not.toContain(key);
      expect(await readFile(join(profile, "settings.json"), "utf8")).toBe('{"theme":"original"}');
      expect(await readdir(profile)).toEqual(["settings.json"]);
      expect(await readFile(join(resources, "app.asar"))).toEqual(archive);
      const url = new URL(desktop.devUrl), ca = await readFile(join(environment.directory, "proxy", "codex-ca.pem"));
      const rpc = (method: string, input: unknown = {}, authorized = true) => new Promise<Buffer>((done, reject) => {
        const body = Buffer.from(JSON.stringify(input)), frame = Buffer.alloc(5); frame.writeUInt32BE(body.length, 1);
        const req = httpsRequest(url.origin + "/exa.language_server_pb.LanguageServerService/" + method, {
          method: "POST", ca, headers: { "content-type": "application/grpc-web+json", ...(authorized ? { authorization: `Bearer ${url.searchParams.get("token")}` } : {}) },
        }, res => {
          const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(Buffer.concat(chunks))); res.on("error", reject);
        });
        req.on("error", reject); req.end(Buffer.concat([frame, body]));
      });
      const denied = await rpc("GetUserStatus", {}, false);
      expect(denied[0]).toBe(128); expect(denied.toString()).toContain("grpc-status: 16");
      const decode = (bytes: Buffer) => JSON.parse(bytes.subarray(5, 5 + bytes.readUInt32BE(1)).toString());
      const status = decode(await rpc("GetUserStatus"));
      expect(status.userStatus.name).toBe("preserved");
      expect(status.userStatus.cascadeModelConfigData.clientModelConfigs.map((m: any) => m.label)).toEqual(["Sonnet 5.5", "GPT 6.1"]);
      const selected = status.userStatus.cascadeModelConfigData.clientModelConfigs[1];
      expect(decode(await rpc("SendUserCascadeMessage", { cascadeConfig: { plannerConfig: { planModel: selected.modelOrAlias.model } } })).cascadeConfig.plannerConfig.customModelInfoOverride.modelName).toBe("gpt-6.1-sol");
      expect((await rpc("StartBattleMode")).toString()).toContain("grpc-status: 12");
      const before = await readFile(join(environment.directory, "proxy", "antigravity.log"), "utf8");
      expect(before).not.toContain(key);
      await impact(["proxy", "restart"], signedOut);
      expect(decode(await rpc("GetUserStatus"))).toEqual(status);
      const after = await readFile(join(environment.directory, "proxy", "antigravity.log"), "utf8");
      expect(after.length).toBeGreaterThan(before.length);
    } finally { await impact(["proxy", "stop"]); }
  }, 30_000);

  it("launches stock Antigravity IDE with the shared proxy and preserves its profile and installation", async () => {
    const app = join(environment.directory, "Antigravity IDE");
    const resources = join(app, "resources", "app");
    await mkdir(join(resources, "extensions", "antigravity"), { recursive: true });
    const product = JSON.stringify({ ideVersion: "2.5.5", nameShort: "Antigravity IDE" });
    await writeFile(join(resources, "product.json"), product);
    const executable = join(app, "antigravity");
    await copyFile(resolve("test/fixtures/antigravity-desktop.mjs"), executable); await chmod(executable, 0o700);
    const profile = join(environment.directory, "original-profile"); await mkdir(profile);
    await writeFile(join(profile, "settings.json"), '{"theme":"original","extensions":"preserved"}');
    const env = { IMPACT_ANTIGRAVITY_BIN: executable, DEV_URL: "https://unrelated.test", IMPACT_MODEL: "gpt-6.1-sol" };
    await impact(["proxy", "setup"]);
    const daemonEnv = { IMPACT_API_KEY: "", IMPACT_ANTIGRAVITY_BIN: "/missing" };
    await impact(["proxy", "start"], daemonEnv);
    try {
      expect(requests).toEqual([]);
      await writeFile(join(environment.directory, "credentials.json"), JSON.stringify({ baseUrl: endpoint, apiKey: key }), { mode: 0o600 });
      await impact(["antigravity", `--user-data-dir=${profile}`, "--native-flag"], env);
      let desktop: any;
      await expect.poll(async () => { try { desktop = JSON.parse(await readFile(join(environment.directory, "proxy", "antigravity-ide.log"), "utf8")); return !!desktop.proxy; } catch { return false; } }).toBe(true);
      expect(desktop.args).toEqual([
        expect.stringMatching(/^--ignore-certificate-errors-spki-list=/),
        expect.stringMatching(/^--proxy-server=http:\/\/127\.0\.0\.1:/),
        expect.stringMatching(/^--refresh-token=/), `--user-data-dir=${profile}`, "--native-flag",
      ]);
      expect(desktop.impactKey).toBeUndefined(); expect(desktop.devUrl).toBeUndefined();
      expect(JSON.stringify(desktop)).not.toContain(key);
      expect(new URL(desktop.proxy).hostname).toBe("127.0.0.1");
      expect(new URL(desktop.proxy).password).not.toBe("");
      expect(desktop.nodeCa).toBe(desktop.sslCa);
      expect(await readFile(desktop.nodeCa, "utf8")).toContain(await readFile(join(environment.directory, "proxy", "antigravity-ca.pem"), "utf8"));
      expect(await readFile(join(profile, "settings.json"), "utf8")).toBe('{"theme":"original","extensions":"preserved"}');
      expect(await readdir(profile)).toEqual(["settings.json"]);
      expect(await readFile(join(resources, "product.json"), "utf8")).toBe(product);
      const saved = JSON.parse(await readFile(join(environment.directory, "proxy", "antigravity-ide-session.json"), "utf8"));
      expect(saved.model).toBe("gpt-6.1-sol"); expect(saved.login).toBeTypeOf("string");
      await expect(impact(["antigravity", "--proxy-server=http://elsewhere"], env)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Impact supplies") });
    } finally { await impact(["proxy", "stop"], daemonEnv); }
  }, 30_000);

  const runCodex = async (codexUrl: string) => {
    const original = '[mcp_servers.example]\ncommand = "server"\n';
    const originalAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "original-access-token" } });
    await writeFile(join(environment.directory, "config.toml"), original);
    await writeFile(join(environment.directory, "auth.json"), originalAuth);
    const failure = await impact(["codex", "exec", "--json", "hello"], {
      IMPACT_CODEX_BIN: fixture,
      CLIENT_EXIT: "17",
    }).then(
      () => undefined,
      (error: { code: number; stdout: string }) => error,
    );
    expect(failure?.code).toBe(17);
    const body = JSON.parse(failure!.stdout);
    expect(body.args.slice(0, 3)).toEqual(["--no-daemon", "--profile", expect.stringMatching(/^impact-/)]);
    expect(body.args.slice(-3)).toEqual(["exec", "--json", "hello"]);
    expect(parse(body.profile)).toMatchObject({
      model: "gpt-6.1-sol",
      mcp_servers: { example: { command: "server" } },
    });
    expect(body.args.join(" ")).not.toContain(key);
    expect(body.key).toBeUndefined();
    expect(body.codexHome).not.toBe(environment.directory);
    expect(body.auth.auth_mode).toBe("chatgptAuthTokens");
    expect(body.auth.tokens.account_id).toBeNull();
    const claims = JSON.parse(Buffer.from(body.auth.tokens.id_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: "ada", email: "Impact · ada@example.com" });
    expect(body.auth.tokens.access_token).not.toBe(key);
    expect(await readFile(join(environment.directory, "config.toml"), "utf8")).toBe(original);
    expect(await readFile(join(environment.directory, "auth.json"), "utf8")).toBe(originalAuth);
    const left = await readdir(environment.directory);
    expect(left.filter((name) => name.startsWith(".impact-") || name.endsWith(".config.toml"))).toEqual([
      basename(body.codexHome),
    ]);
    expect((await readdir(body.codexHome)).sort()).toEqual(["archived_sessions", "sessions", "shell_snapshots"]);
    expect(parse(body.profile)).toMatchObject({ model_providers: { impact: { base_url: `${codexUrl}/v1` } }, chatgpt_base_url: codexUrl });
  };
});

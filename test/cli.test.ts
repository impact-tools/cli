import type { AddressInfo } from "node:net";

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
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
      IMPACT_CODEX_BIN: missing,
      IMPACT_CURSOR_BIN: missing,
      IMPACT_KILO_BIN: fixture,
      IMPACT_OPENCODE_BIN: missing,
      FORCE_COLOR: "3",
      TERM: "xterm-256color",
    });
    expect(result.stdout).toBe(
      `Impact: ${endpoint}\nModels: 2\nclaude: ${fixture}\ncodex: not installed\ncursor: not installed\nkilo: ${fixture}\nopencode: not installed\n`,
    );
    expect(result.stderr).toBe("");
  });

  it.each([false, true])("launches Cursor with a scoped backend and persistent profile (custom=%s)", async (custom) => {
    const directory = join(environment.directory, custom ? "custom-profile" : "cursor/profile");
    const result = await impact(["cursor", "--new-window", "a path with spaces"], {
      IMPACT_CURSOR_BIN: fixture,
      ...(custom ? { IMPACT_CURSOR_USER_DATA_DIR: directory } : {}),
      VSCODE_IPC_HOOK_CLI: "existing-cursor-ipc",
    });
    const body = JSON.parse(result.stdout);
    expect(body.args.slice(0, 2)).toEqual(["--user-data-dir", directory]);
    expect(body.args.slice(3)).toEqual(["--wait", "--new-window", "a path with spaces"]);
    expect(body.args.join(" ")).not.toContain(key);
    expect(body.key).toBeUndefined();
    expect(body.cursorIpc).toBeUndefined();
    expect(body.cursorModels.data.map((model: { id: string }) => model.id)).toEqual([
      "claude-sonnet-5-5",
      "gpt-6.1-sol",
    ]);
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(requests).toEqual(["/v1/models"]);
    const backend = body.args[2].slice("--test-backend-url=".length);
    expect(new URL(backend).hostname).toBe("127.0.0.1");
    await expect(fetch(backend + "/v1/models")).rejects.toThrow();
  });

  it("bootstraps an existing Cursor Desktop session into the managed profile", async () => {
    const source = join(environment.directory, "native-cursor");
    const target = join(environment.directory, "impact-cursor");
    const sourceState = join(source, "User", "globalStorage", "state.vscdb");
    const targetState = join(target, "User", "globalStorage", "state.vscdb");
    await mkdir(join(source, "User", "globalStorage"), { recursive: true });
    await mkdir(join(target, "User", "globalStorage"), { recursive: true });
    await writeFile(sourceState, "cursor auth state");
    await writeFile(targetState, "empty state created by an earlier launch");
    await impact(["cursor", "."], {
      IMPACT_CURSOR_BIN: fixture,
      IMPACT_CURSOR_PROFILE_SOURCE: source,
      IMPACT_CURSOR_USER_DATA_DIR: target,
    });
    expect(await readFile(targetState, "utf8")).toBe("cursor auth state");
    expect(await readFile(join(target, ".impact-auth-bootstrap"), "utf8")).toBe(`${sourceState}\n`);
  });

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

  it("serves API traffic until the standalone proxy receives SIGINT, then releases its listener", async () => {
    const child = spawn("bun", ["--no-env-file", entry, "proxy", "--port", "0"], {
      env: { ...process.env, IMPACT_API_KEY: key, IMPACT_BASE_URL: endpoint },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const ready = Promise.withResolvers<string>();
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const baseUrl = output.match(/Proxy: (http:\/\/127\.0\.0\.1:\d+\/[\w-]+)/)?.[1];
      if (baseUrl) ready.resolve(baseUrl);
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const exited = once(child, "close");
    child.once("exit", () => ready.reject(new Error(`Proxy exited before ready: ${errors}`)));
    try {
      const baseUrl = await ready.promise;
      const response = await fetch(`${baseUrl}/v1/models`);
      expect(response.status).toBe(200);
      const models = (await response.json()) as { data: { id: string }[] };
      expect(models.data.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "gpt-6.1-sol"]);
      expect(output).toContain(`OpenAI base URL: ${baseUrl}/v1`);
      child.kill("SIGINT");
      await exited;
      expect(errors).toBe("");
      await expect(fetch(baseUrl + "/v1/models")).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
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
    expect(JSON.parse(result.stdout).cwd).toBe(workspace);
  });

  it("runs Codex with an isolated home and profile, keeps the user's files and returns its exit code", async () => {
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
    expect(body.codexHome).not.toBe(environment.directory);
    expect(body.auth.auth_mode).toBe("chatgptAuthTokens");
    expect(body.auth.tokens.account_id).toBeNull();
    const claims = JSON.parse(Buffer.from(body.auth.tokens.id_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: "ada", email: "Impact · ada@example.com" });
    expect(body.auth.tokens.access_token).not.toBe(key);
    expect(await readFile(join(environment.directory, "config.toml"), "utf8")).toBe(original);
    expect(await readFile(join(environment.directory, "auth.json"), "utf8")).toBe(originalAuth);
    const left = await readdir(environment.directory);
    expect(left.filter((name) => name.startsWith(".impact-") || name.endsWith(".config.toml"))).toEqual([]);
  });
});

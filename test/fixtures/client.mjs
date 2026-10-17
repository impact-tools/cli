#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli 0.160.0");
  process.exit(0);
}
const settingsIndex = args.indexOf("--settings");
const settings = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : undefined;
let cursorModels;
let cursorProfile;
let cursorProxy;
let cursorCertificate;
if (args.includes("--user-data-dir")) {
  const { DatabaseSync } = await import("node:sqlite");
  const { request } = await import("node:http");
  const { connect: connectTls } = await import("node:tls");
  const { connect: connectHttp2 } = await import("node:http2");
  const directory = args[args.indexOf("--user-data-dir") + 1];
  const db = new DatabaseSync(join(directory, "User", "globalStorage", "state.vscdb"));
  const get = (name) => db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(name)?.value;
  const token = get("cursorAuth/accessToken");
  cursorProfile = { email: get("cursorAuth/cachedEmail"), membership: get("cursorAuth/stripeMembershipType"), tokenIsImpactKey: token === process.env.IMPACT_API_KEY };
  db.close();
  cursorProxy = process.env.HTTPS_PROXY;
  cursorCertificate = process.env.NODE_EXTRA_CA_CERTS;
  const proxy = new URL(cursorProxy);
  const socket = await new Promise((resolve, reject) => {
    const tunnel = request({ hostname: proxy.hostname, port: proxy.port, method: "CONNECT", path: "api2.cursor.sh:443", headers: { "proxy-authorization": "Basic " + Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64") } });
    tunnel.on("connect", (response, socket) => response.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${response.statusCode}`)));
    tunnel.on("error", reject);
    tunnel.end();
  });
  const session = connectHttp2("https://api2.cursor.sh", { createConnection: () => connectTls({ socket, servername: "api2.cursor.sh", ALPNProtocols: ["h2"] }) });
  try {
    cursorModels = await new Promise((resolve, reject) => {
      session.on("error", reject);
      const call = session.request({ ":method": "POST", ":path": "/aiserver.v1.AiService/AvailableModels", "content-type": "application/json", authorization: `Bearer ${token}` });
      const chunks = [];
      call.on("data", (chunk) => chunks.push(chunk));
      call.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
      call.on("error", reject);
      call.end("{}");
    });
  } finally { session.destroy(); socket.destroy(); }
}
console.log(
  JSON.stringify({
    args,
    cursorModels,
    cursorProfile,
    cursorProxy,
    cursorCertificate,
    cursorIpc: process.env.VSCODE_IPC_HOOK_CLI,
    cwd: process.cwd(),
    kiloConfig: process.env.KILO_CONFIG_CONTENT ? JSON.parse(process.env.KILO_CONFIG_CONTENT) : undefined,
    openCodeConfig: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : undefined,
    codexHome: process.env.CODEX_HOME,
    auth:
      process.env.CODEX_HOME && args.includes("--profile")
        ? JSON.parse(readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8"))
        : undefined,
    profile: args.includes("--profile")
      ? readFileSync(join(process.env.CODEX_HOME, args[args.indexOf("--profile") + 1] + ".config.toml"), "utf8")
      : undefined,
    endpoint: process.env.ANTHROPIC_BASE_URL,
    provider: process.env.CLAUDE_CODE_USE_VERTEX,
    settings,
    statusFile: process.env.IMPACT_CLAUDE_STATUS_FILE,
    models: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name === "ANTHROPIC_MODEL" ||
          name.startsWith("ANTHROPIC_DEFAULT_") ||
          name === "CLAUDE_CODE_SUBAGENT_MODEL" ||
          name === "ANTHROPIC_SMALL_FAST_MODEL",
      ),
    ),
    status:
      settings?.statusLine && process.env.CLIENT_STATUS_INPUT
        ? execSync(settings.statusLine.command, { encoding: "utf8", input: process.env.CLIENT_STATUS_INPUT })
        : undefined,
    helperToken: settings ? execSync(settings.apiKeyHelper, { encoding: "utf8" }).trim() : undefined,
    key: process.env.IMPACT_API_KEY,
    input: process.env.CLIENT_READ_STDIN
      ? await new Promise((resolve) => {
          let text = "";
          process.stdin.on("data", (chunk) => {
            text += chunk;
          });
          process.stdin.on("end", () => resolve(text));
        })
      : undefined,
  }),
);
process.exitCode = Number(process.env.CLIENT_EXIT ?? 0);

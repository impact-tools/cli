import { Effect, Schema } from "effect";
import { existsSync } from "node:fs";
import { open, realpath, readlink, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { requireProxy } from "../../proxy/Control.ts";
import type { LaunchOptions } from "../Client.ts";
import { certificateSpki } from "../cursor/HttpsProxy.ts";
import { accessToken, SESSION } from "./Bridge.ts";
import { IDE_SESSION } from "./Ide.ts";

const Package = Schema.Struct({ version: Schema.String });
const readPackage = Schema.decodeUnknownSync(Package);

/** Read the installed archive, never extract or edit the application. */
export async function antigravityInstallation(executable: string) {
  const directory = dirname(await realpath(executable));
  const resources = [resolve(directory, "../Resources"), join(directory, "resources"), resolve(directory, "../resources"), resolve(directory, "../../..")].find(path => existsSync(join(path, "app.asar")) || existsSync(join(path, "app/extensions/antigravity")));
  if (!resources) throw new CliError({ message: "Cannot locate Antigravity IDE or Agents. Set IMPACT_ANTIGRAVITY_BIN to the installed desktop executable." });
  if (existsSync(join(resources, "app/extensions/antigravity"))) {
    const product = Schema.decodeUnknownSync(Schema.Struct({ ideVersion: Schema.String, nameShort: Schema.String }))(JSON.parse(await readFile(join(resources, "app/product.json"), "utf8")));
    return { kind: "ide" as const, executable, version: product.ideVersion, profileName: product.nameShort };
  }
  const file = await open(join(resources, "app.asar"), "r");
  try {
    const prefix = Buffer.alloc(16); await file.read(prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(4), length = prefix.readUInt32LE(12);
    if (size > 16 * 1024 * 1024 || length > size) throw new Error("Invalid archive header");
    const header = Buffer.alloc(length); await file.read(header, 0, length, 16);
    const entry = JSON.parse(header.toString()).files["package.json"];
    if (!entry || entry.size > 1024 * 1024) throw new Error("Invalid package entry");
    const bytes = Buffer.alloc(entry.size); await file.read(bytes, 0, entry.size, 8 + size + Number(entry.offset));
    const { version } = readPackage(JSON.parse(bytes.toString()));
    const languageServer = join(resources, "bin", process.platform === "win32" ? "language_server.exe" : "language_server");
    if (!existsSync(languageServer) || !version.startsWith("2.")) throw new Error("Unsupported Antigravity installation");
    return { kind: "agents" as const, executable: languageServer, version, profileName: "antigravity" };
  } finally { await file.close(); }
}

export const prepareAntigravity = Effect.fn("prepareAntigravity")(function* ({ executable, args, connection }: LaunchOptions) {
  const { setup, status } = yield* requireProxy(connection);
  if (!setup.codex || !status.antigravity)
    return yield* new CliError({ message: "Add Antigravity support: impact proxy setup, then impact proxy restart." });
  const installation = yield* Effect.tryPromise({ try: () => antigravityInstallation(executable), catch: error => error instanceof CliError ? error : new CliError({ message: "Cannot read this Antigravity installation. Set IMPACT_ANTIGRAVITY_BIN to the desktop executable." }) });
  if (installation.kind === "ide" && (!setup.antigravityIde || !status.antigravityIde))
    return yield* new CliError({ message: "Add Antigravity IDE support: impact proxy setup, then impact proxy restart." });
  const reserved = ["--proxy-server", "--proxy-pac-url", "--no-proxy-server", "--proxy-bypass-list", "--ignore-certificate-errors", "--ignore-certificate-errors-spki-list", "--refresh-token"];
  if (args.some(arg => reserved.some(name => arg === name || arg.startsWith(name + "="))))
    return yield* new CliError({ message: "Impact supplies Antigravity's proxy, certificate and login arguments." });
  const origin = `https://127.0.0.1:${setup.codex.port}`;
  const token = accessToken(setup.config.sessionKey, connection);
  yield* Effect.tryPromise({
    try: async () => {
      const explicit = args.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? (args.includes("--user-data-dir") ? args[args.indexOf("--user-data-dir") + 1] : undefined);
      const name = installation.profileName;
      const userData = explicit ?? (process.platform === "darwin" ? join(homedir(), "Library/Application Support", name) : process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), name) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), name));
      const lock = await readlink(join(userData, "SingletonLock")).catch(() => "");
      const pid = Number(lock.split("-").at(-1));
      if (pid) {
        let running = false;
        try { process.kill(pid, 0); running = true; } catch {}
        if (running) throw new CliError({ message: "Antigravity is already open. Quit Antigravity, then run impact antigravity so it receives the gateway settings. Your profile is preserved." });
      }
      const body = Buffer.from(JSON.stringify({ ...installation, ...(process.env.IMPACT_MODEL ? { model: process.env.IMPACT_MODEL } : {}) }));
      await new Promise<void>((resolve, reject) => {
        const req = request(origin + (installation.kind === "ide" ? IDE_SESSION : SESSION), { method: "POST", ca: setup.codex!.ca.toString(), timeout: 60_000, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": body.length } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on("data", chunk => { size += chunk.length; if (size > 65536) res.destroy(); else chunks.push(chunk); });
          res.on("error", reject);
          res.on("end", () => {
            if (res.statusCode === 200) return resolve();
            let message = "The Impact proxy could not prepare Antigravity. Check impact proxy status.";
            try { message = JSON.parse(Buffer.concat(chunks).toString()).error?.message || message; } catch {}
            reject(new CliError({ message }));
          });
        });
        req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject); req.end(body);
      });
    },
    catch: error => error instanceof CliError ? error : new CliError({ message: "Cannot connect Antigravity to the Impact proxy. Check impact proxy status." }),
  });
  const env = { ...process.env };
  for (const key of ["IMPACT_API_KEY", "ELECTRON_RUN_AS_NODE", "VSCODE_IPC_HOOK_CLI", "DEV_URL", "AGY_LLM_GATEWAY_URL", "AGY_LLM_GATEWAY_API_KEY", "AGY_LLM_GATEWAY_HEADERS", "AGY_LLM_GATEWAY_MODELS", "AGY_LLM_GATEWAY_CA_CERT", "AGY_LLM_GATEWAY_PROXY_URL"]) delete env[key];
  if (installation.kind === "ide") {
    const ide = setup.antigravityIde!;
    const certificateFile = join(setup.paths.directory, "antigravity-roots.pem");
    yield* Effect.tryPromise({ try: async () => {
      const custom = [...new Set([process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE].filter((path): path is string => !!path))];
      const extra = await Promise.all(custom.map(path => readFile(path, "utf8")));
      await writeFile(certificateFile, [...rootCertificates, ...extra, ide.ca.toString()].join("\n"), { mode: 0o600 });
    }, catch: () => new CliError({ message: "Cannot create Antigravity's CA bundle." }) });
    const { port, username, password } = setup.config;
    const proxy = `http://${username}:${password}@127.0.0.1:${port}`;
    return {
      args: [`--ignore-certificate-errors-spki-list=${ide.tls.spki}`, `--proxy-server=http://127.0.0.1:${port}`, `--refresh-token=${token}`, ...args],
      env: { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
        NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_EXTRA_CA_CERTS: certificateFile, SSL_CERT_FILE: certificateFile },
      detach: { log: join(setup.paths.directory, "antigravity-ide.log"), append: true },
    };
  }
  return {
    args: [`--ignore-certificate-errors-spki-list=${certificateSpki(setup.codex.tls.cert)}`, ...args],
    env: { ...env, DEV_URL: `${origin}/impact-antigravity/open?token=${token}` },
    detach: { log: join(setup.paths.directory, "antigravity-desktop.log"), append: true },
  };
}, mapPlatformError("Cannot prepare Antigravity"));

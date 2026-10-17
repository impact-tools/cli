import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { ProtocolError } from "../cursor/Impact.ts";

export interface AntigravityRuntime { readonly origin: string; readonly csrf: string; readonly child: ChildProcess; close(): Promise<void> }
export async function startLanguageServer(options: { executable: string; version: string; gateway: string; token: string; ca: string; log: string }): Promise<AntigravityRuntime> {
  if (!existsSync(options.executable)) throw new ProtocolError("failed_precondition", "Antigravity's language_server is missing. Reinstall Antigravity Desktop.");
  const csrf = randomUUID();
  const env = { ...process.env };
  for (const key of ["IMPACT_API_KEY", "AGY_LLM_GATEWAY_MODELS", "AGY_LLM_GATEWAY_HEADERS", "AGY_LLM_GATEWAY_PROXY_URL", "DEV_URL", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  Object.assign(env, { AGY_LLM_GATEWAY_URL: options.gateway, AGY_LLM_GATEWAY_API_KEY: options.token, AGY_LLM_GATEWAY_CA_CERT: options.ca });
  const args = ["--standalone", "--override_ide_name", "antigravity", "--subclient_type", "hub", "--override_ide_version", options.version,
    "--override_user_agent_name", "antigravity", "--http_server_port", "0", "--https_server_port", "0", "--csrf_token", csrf,
    "--app_data_dir", "antigravity", "--api_server_url", "https://generativelanguage.googleapis.com", "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
    "--disable_telemetry", "--enable_sidecars", "--exit_on_stdin_close"];
  if (process.env.IMPACT_ANTIGRAVITY_GEMINI_DIR) args.push("--gemini_dir", process.env.IMPACT_ANTIGRAVITY_GEMINI_DIR);
  const child = spawn(options.executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const log = createWriteStream(options.log, { flags: "a", mode: 0o600 });
  log.on("error", () => {});
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  child.once("close", () => log.end());
  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => stopping ??= new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.stdin?.end(); child.kill("SIGTERM");
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => failed(), 30_000);
      const lines = [createInterface({ input: child.stdout! }), createInterface({ input: child.stderr! })];
      const done = () => { clearTimeout(timer); child.off("error", failed); child.off("exit", failed); for (const line of lines) line.close(); child.stdout!.resume(); child.stderr!.resume(); };
      const failed = () => { done(); reject(new ProtocolError("unavailable", `Antigravity's language server did not start. Log: ${options.log}`)); };
      child.once("error", failed); child.once("exit", failed);
      for (const line of lines) line.on("line", text => {
        const match = /listening on \w+ port at (\d+) for HTTP\b/.exec(text);
        if (match) { done(); resolve(Number(match[1])); }
      });
    });
    return { origin: `http://127.0.0.1:${port}`, csrf, child, close };
  } catch (error) { await close(); throw error; }
}

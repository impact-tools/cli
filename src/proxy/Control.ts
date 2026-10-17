import { Effect, Schema } from "effect";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname } from "node:path";

import type { Connection } from "../config/Connection.ts";

import { configFile } from "../config/Credentials.ts";
import { loginId } from "../auth/Identity.ts";
import { CliError } from "../Errors.ts";
import { selfCommand } from "../process/Self.ts";
import { requireSetup, type ProxySetup } from "./State.ts";

export const ProxyStatus = Schema.Struct({
  pid: Schema.Int,
  version: Schema.String,
  startedAt: Schema.String,
  port: Schema.Int,
  codexPort: Schema.optional(Schema.Int),
  antigravity: Schema.optional(Schema.Boolean),
  antigravityIde: Schema.optional(Schema.Boolean),
  /** Identifies the Impact login the proxy currently reads, without revealing its key. */
  login: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  account: Schema.optional(Schema.Struct({ id: Schema.String, email: Schema.String })),
  models: Schema.optional(Schema.Int),
  cursorVersion: Schema.optional(Schema.String),
});
export type ProxyStatus = typeof ProxyStatus.Type;

export const CursorSession = Schema.Struct({
  account: Schema.Struct({ id: Schema.String, email: Schema.String, token: Schema.String, refreshToken: Schema.String }),
  modelIds: Schema.Array(Schema.String),
});
export type CursorSession = typeof CursorSession.Type;

export const STATUS_PATH = "/impact/status";
export const SESSION_PATH = "/impact/session";
export const SHUTDOWN_PATH = "/impact/shutdown";

/**
 * The daemon must read saved credentials on every request, not inherit invocation-only login overrides.
 * A first start before login may still use the invocation credentials; once a credentials file exists, both
 * overrides are removed so login and logout take effect without a restart.
 */
export const daemonEnvironment = (source: NodeJS.ProcessEnv = process.env, hasSavedLogin = true) => {
  const environment = { ...source };
  delete environment.IMPACT_LAUNCH_CWD;
  if (hasSavedLogin) {
    delete environment.IMPACT_API_KEY;
    delete environment.IMPACT_BASE_URL;
  }
  return environment;
};

export { loginId };

/** The authenticated control request; `undefined` when nothing of ours answers on the port. */
const get = (setup: ProxySetup, path: string, timeout = 3000, method = "GET") =>
  new Promise<{ readonly status: number; readonly body: unknown } | undefined>((resolve) => {
    const { username, password, port } = setup.config;
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout,
        headers: { "proxy-authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", () => resolve(undefined));
        response.once("end", () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            // Older daemons answer unknown control routes with plain text or an empty body.
            resolve({ status: response.statusCode ?? 0, body: undefined });
          }
        });
      },
    );
    call.once("timeout", () => call.destroy());
    call.once("error", () => resolve(undefined));
    call.end();
  });

const decodeStatus = Schema.decodeUnknownOption(ProxyStatus);
const decodeSession = Schema.decodeUnknownOption(CursorSession);

const ErrorBody = Schema.Struct({ error: Schema.String });
const decodeError = Schema.decodeUnknownOption(ErrorBody);

export const proxyStatus = (setup: ProxySetup) =>
  Effect.promise(async () => {
    const reply = await get(setup, STATUS_PATH);
    const status = reply?.status === 200 ? decodeStatus(reply.body) : undefined;
    return status?._tag === "Some" ? status.value : undefined;
  });

/** The local Cursor sign-in; the proxy loads Cursor support on this first request. */
export const cursorSession = (setup: ProxySetup) =>
  Effect.promise(() => get(setup, SESSION_PATH, 60_000)).pipe(
    Effect.flatMap((reply) => {
      const session = reply?.status === 200 ? decodeSession(reply.body) : undefined;
      if (session?._tag === "Some") return Effect.succeed(session.value);
      const failure = reply ? decodeError(reply.body) : undefined;
      return Effect.fail(
        new CliError({
          message: failure?._tag === "Some" ? failure.value.error : "The Impact proxy did not return a Cursor session. Run impact proxy restart.",
        }),
      );
    }),
  );

/** The running proxy for `connection`; Cursor launches never start one implicitly. */
export const requireProxy = (connection: Connection) =>
  Effect.gen(function* () {
    const setup = yield* requireSetup;
    const status = yield* proxyStatus(setup);
    if (!status) return yield* new CliError({ message: "The Impact proxy is not running. Start it with impact proxy start." });
    if (status.login === undefined)
      return yield* new CliError({ message: "The Impact proxy finds no Impact login. Run impact login." });
    // The proxy reads the saved login, or the IMPACT_API_KEY it was started with.
    if (status.login !== loginId(connection))
      return yield* new CliError({
        message: "The Impact proxy uses a different Impact login. Restart it from this shell: impact proxy restart.",
      });
    return { setup, status };
  });

const waitUntil = async <A>(check: () => Promise<A | undefined>, timeout: number) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

const lastError = (path: string) => {
  try {
    const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.at(-1);
  } catch {
    return undefined;
  }
};

/** Starts `impact proxy run` in the background with its output in the proxy log. */
export const startProxy = (setup: ProxySetup) =>
  Effect.gen(function* () {
    const running = yield* proxyStatus(setup);
    if (running) return { status: running, started: false };
    return yield* Effect.tryPromise({
      try: async () => {
        const log = openSync(setup.paths.log, "w", 0o600);
        const [command, ...prefix] = selfCommand();
        let exited = false;
        try {
          const child = spawn(command!, [...prefix, "proxy", "run"], {
            cwd: setup.paths.directory,
            detached: true,
            stdio: ["ignore", log, log],
            env: {
              ...daemonEnvironment(process.env, existsSync(configFile())),
              IMPACT_CONFIG_DIR: dirname(setup.paths.directory),
              IMPACT_DISABLE_UPDATE_CHECK: "1",
              NO_COLOR: "1",
            },
            windowsHide: true,
          });
          child.once("error", () => (exited = true));
          child.once("exit", () => (exited = true));
          child.unref();
        } finally {
          closeSync(log);
        }
        const status = await waitUntil(async () => {
          const value = await Effect.runPromise(proxyStatus(setup));
          return value ?? (exited ? null : undefined);
        }, 30_000);
        if (!status)
          throw new CliError({
            message: `The Impact proxy did not start: ${lastError(setup.paths.log) ?? "no output"}. Log: ${setup.paths.log}`,
          });
        return { status, started: true };
      },
      catch: (error) =>
        error instanceof CliError ? error : new CliError({ message: `Cannot start the Impact proxy. Log: ${setup.paths.log}` }),
    });
  });

export const stopProxy = Effect.fn("stopProxy")(function* (setup: ProxySetup) {
  const status = yield* proxyStatus(setup);
  if (!status) return undefined;
  yield* Effect.tryPromise({
    try: async () => {
      const reply = await get(setup, SHUTDOWN_PATH, 3000, "POST");
      if (reply?.status === 404 || reply?.status === 405) {
        // Legacy daemons have authenticated status but no shutdown route. Recheck their
        // identity immediately before signaling; never escalate using an advertised PID.
        const current = await Effect.runPromise(proxyStatus(setup));
        if (
          !current ||
          current.pid !== status.pid ||
          current.startedAt !== status.startedAt ||
          current.version !== status.version ||
          current.port !== status.port ||
          current.login !== status.login ||
          current.port !== setup.config.port ||
          !Number.isSafeInteger(current.pid) ||
          current.pid <= 0 ||
          current.pid > 0x7fffffff ||
          current.pid === process.pid
        ) throw new Error("The running proxy identity changed or its PID is invalid.");
        process.kill(current.pid, "SIGTERM");
      } else if (reply?.status !== 202) {
        throw new Error("The running proxy did not accept authenticated shutdown.");
      }
      const stopped = await waitUntil(async () => ((await Effect.runPromise(proxyStatus(setup))) ? undefined : true), 5000);
      if (!stopped) throw new Error("The proxy did not stop in time.");
    },
    catch: () => new CliError({ message: "Cannot stop the Impact proxy." }),
  });
  return status;
});

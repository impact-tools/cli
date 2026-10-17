import type { IncomingMessage, ServerResponse } from "node:http";

import { Console, Effect, FileSystem, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Connection } from "../config/Connection.ts";

import { version } from "../../package.json";
import { loginId } from "../auth/Identity.ts";
import { createAntigravityBridge } from "../clients/antigravity/Bridge.ts";
import { createAntigravityIde, IDE_SESSION } from "../clients/antigravity/Ide.ts";
import { IDE_PROXY_HOSTS } from "../clients/antigravity/Tls.ts";
import { findExecutable } from "../clients/Client.ts";
import { codexProxy, UpstreamError } from "../clients/codex/Proxy.ts";
import { CursorAccount, impactJson, type CursorModel } from "../clients/cursor/Account.ts";
import { cursorHttpsProxy, type NativeHandler } from "../clients/cursor/HttpsProxy.ts";
import { ProtocolError } from "../clients/cursor/Impact.ts";
import { createCursorNative, failCursorRequest } from "../clients/cursor/Native.ts";
import { resolveCursorApp } from "../clients/cursor/Profile.ts";
import { CursorWire } from "../clients/cursor/Wire.ts";
import { configFile, daemonConnection } from "../config/Credentials.ts";
import { SESSION_PATH, SHUTDOWN_PATH, STATUS_PATH, type CursorSession, type ProxyStatus } from "./Control.ts";
import { requireSetup } from "./State.ts";

const Identity = Schema.Struct({ account: Schema.Struct({ id: Schema.String, email: Schema.String }) });
const readIdentity = Schema.decodeUnknownSync(Identity);

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(body));
};

const message = (error: unknown, fallback: string) => (error instanceof ProtocolError ? error.message : fallback);

/** The installed editor's descriptor directory and version, read without running it. */
const installedCursor = () => {
  const executable = findExecutable("cursor");
  if (!executable) throw new ProtocolError("unavailable", "Install Cursor Desktop, or set IMPACT_CURSOR_BIN for impact proxy start.");
  let directory: string;
  try {
    directory = resolveCursorApp(executable);
  } catch {
    throw new ProtocolError("unavailable", "Cannot find Cursor's protocol descriptors. Set IMPACT_CURSOR_APP_DIR for impact proxy start.");
  }
  let release: string | undefined;
  for (const base of [join(directory, "Contents/Resources/app"), join(directory, "resources/app"), directory]) {
    const path = join(base, "package.json");
    if (!existsSync(path)) continue;
    try {
      release = String(JSON.parse(readFileSync(path, "utf8")).version);
    } catch {
      /* The descriptor loader reports a broken installation. */
    }
    break;
  }
  return { directory, release };
};

/**
 * Reuses a successful result for `ttl` milliseconds, so request bursts read files once while changes still
 * apply quickly. Failures are never reused: a login or installation is seen as soon as it exists.
 */
const fresh = <A>(read: () => Promise<A>, ttl = 2000) => {
  let cached: { readonly value: Promise<A>; readonly at: number } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > ttl) {
      const value = read();
      cached = { value, at: Date.now() };
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    return cached.value;
  };
};

interface CursorBackend {
  readonly account: CursorAccount;
  readonly models: readonly CursorModel[];
  readonly native: ReturnType<typeof createCursorNative>;
  readonly version: string | undefined;
}

/**
 * The background proxy: Cursor's HTTPS proxy and Codex's loopback endpoint. Starting checks nothing beyond
 * its own files. Each request reads the current Impact login; Cursor's descriptors and account load on its
 * first request and again after the login or the installed Cursor changes.
 */
export const serveProxy = Effect.fn("serveProxy")(function* () {
  let shutdown!: () => void;
  const setup = yield* requireSetup;
  const stopped = new Promise<void>((resolve) => { shutdown = resolve; });
  const context = yield* Effect.context<FileSystem.FileSystem>();
  const credentialState = { bootstrap: !existsSync(configFile()) };
  const login = fresh(() =>
    Effect.runPromise(
      daemonConnection(credentialState).pipe(
        Effect.provideContext(context),
        Effect.mapError(() => new ProtocolError("unauthenticated", "Sign in with impact login.")),
      ),
    ),
  );
  const cursorApp = fresh(async () => installedCursor());
  const sessionKey = Buffer.from(setup.config.sessionKey, "base64url");

  const identities = new Map<string, Promise<{ id: string; email: string }>>();
  const identity = (connection: Connection) => {
    const id = loginId(connection);
    let pending = identities.get(id);
    if (!pending) {
      pending = impactJson(connection, "/v1/usage", AbortSignal.timeout(20_000)).then((body) => readIdentity(body).account);
      identities.set(id, pending);
      pending.catch(() => identities.delete(id));
    }
    return pending;
  };

  let cursor: { readonly key: string; readonly backend: Promise<CursorBackend> } | undefined;
  let ready: { readonly key: string; readonly backend: CursorBackend } | undefined;
  const cursorBackend = async () => {
    const connection = await login();
    const app = await cursorApp();
    const key = [loginId(connection), app.directory, app.release ?? ""].join("\n");
    if (cursor?.key === key) return cursor.backend;
    const previous = cursor;
    const backend = (async (): Promise<CursorBackend> => {
      const wire = await CursorWire.load(app.directory).catch(() => {
        throw new ProtocolError("unavailable", "Cannot read this Cursor build's protocol descriptors. Set IMPACT_CURSOR_APP_DIR for impact proxy start.");
      });
      const { account, models } = await CursorAccount.load(connection, AbortSignal.timeout(30_000), sessionKey).catch(() => {
        throw new ProtocolError("unavailable", "Impact must return an account and enabled models. Check impact status.");
      });
      const native = createCursorNative(connection, account, models, wire, { persistent: true });
      return { account, models, native, version: wire.clientVersion };
    })();
    cursor = { key, backend };
    backend.then(
      (loaded) => {
        ready = { key, backend: loaded };
        void previous?.backend.then((old) => old.native.close(), () => {});
      },
      () => {
        if (cursor?.backend === backend) cursor = previous;
      },
    );
    return backend;
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => cursor?.backend.then((backend) => backend.native.close(), () => {}) ?? Promise.resolve()),
  );

  const handler: NativeHandler = (request, response, host, proxyContext) => {
    cursorBackend().then(
      (backend) => backend.native.handler(request, response, host, proxyContext),
      (error) => {
        request.resume();
        failCursorRequest(request, response, error instanceof ProtocolError ? error : new ProtocolError("unavailable", "Cannot reach Impact."));
      },
    );
  };

  const startedAt = new Date().toISOString();
  const status = async (): Promise<ProxyStatus> => {
    const base: ProxyStatus = {
      pid: process.pid,
      version,
      startedAt,
      port: setup.config.port,
      ...(setup.codex ? { codexPort: setup.codex.port, antigravity: true } : {}),
      ...(setup.antigravityIde ? { antigravityIde: true } : {}),
    };
    const connection = await login().catch(() => undefined);
    if (!connection) return base;
    const account = await Promise.race([
      identity(connection).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
    const loaded = ready?.key.startsWith(`${loginId(connection)}\n`) ? ready.backend : undefined;
    return {
      ...base,
      login: loginId(connection),
      baseUrl: connection.baseUrl,
      ...(account ? { account } : {}),
      ...(loaded ? { models: loaded.models.length, ...(loaded.version ? { cursorVersion: loaded.version } : {}) } : {}),
    };
  };

  const control = (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0];
    if (path === SHUTDOWN_PATH && request.method === "POST") {
      request.resume();
      json(response, 202, { ok: true });
      setImmediate(shutdown);
      return true;
    }
    if (request.method !== "GET" || (path !== STATUS_PATH && path !== SESSION_PATH)) return false;
    request.resume();
    const answer =
      path === STATUS_PATH
        ? status()
        : cursorBackend().then(
            ({ account, models }): CursorSession => ({
              account: { id: account.id, email: account.email, token: account.token, refreshToken: account.refreshToken },
              modelIds: models.map((model) => model.id),
            }),
          );
    answer.then(
      (body) => json(response, 200, body),
      (error) => json(response, 503, { error: message(error, "Cannot prepare the Cursor session.") }),
    );
    return true;
  };

  const ide = setup.antigravityIde ? createAntigravityIde({ key: setup.config.sessionKey, directory: setup.paths.directory, login, identity }) : undefined;
  yield* cursorHttpsProxy(handler, { port: setup.config.port, tls: setup.tls, credentials: setup.config, control,
    ...(ide && setup.antigravityIde ? { additional: { hosts: IDE_PROXY_HOSTS, tls: setup.antigravityIde.tls, handler: ide.handle } } : {}),
  });
  const antigravity = setup.codex ? createAntigravityBridge({
    origin: `https://127.0.0.1:${setup.codex.port}`, ca: setup.paths.codexCa, key: setup.config.sessionKey,
    directory: setup.paths.directory, login,
  }) : undefined;
  if (antigravity) yield* Effect.addFinalizer(() => Effect.promise(() => antigravity.close()));
  if (setup.codex)
    yield* codexProxy(
      async () => {
        const connection = await login().catch(() => {
          throw new UpstreamError(401, "Sign in with impact login.");
        });
        const account = await identity(connection).catch(() => {
          throw new UpstreamError(502, "Cannot read the Impact account.");
        });
        return { connection, accountId: account.id };
      },
      { tls: setup.codex.tls, port: setup.codex.port, prefix: setup.codex.prefix,
        fallback: antigravity && { upgrade: antigravity.upgrade, handle(request, response) {
          if (ide && request.url?.split("?")[0] === IDE_SESSION) return ide.handle(request, response, "");
          antigravity.handle(request, response);
        } },
      },
    );
  yield* Console.log(
    `${startedAt} Impact proxy ${version}: Cursor on 127.0.0.1:${setup.config.port}${setup.codex ? `, Codex and Antigravity on 127.0.0.1:${setup.codex.port}` : ""}`,
  );
  return yield* Effect.promise(() => stopped);
}, Effect.scoped);

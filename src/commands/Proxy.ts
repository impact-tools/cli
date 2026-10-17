import { Effect, Option, Stdio } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { version } from "../../package.json";
import { CURSOR_CERTIFICATE_NAMES } from "../clients/cursor/HttpsProxy.ts";
import { CliError } from "../Errors.ts";
import { serveProxy } from "../proxy/Daemon.ts";
import { proxyStatus, startProxy, stopProxy, type ProxyStatus } from "../proxy/Control.ts";
import { completeProxySetup, createProxySetup, readProxySetup, requireSetup, type ProxySetup } from "../proxy/State.ts";
import { Output } from "../ui/Output.ts";

const date = (value: string) => new Date(value).toISOString().slice(0, 10);

const uptime = (since: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

const setupRows = (setup: ProxySetup): ReadonlyArray<readonly [string, string]> => [
  ["Directory", setup.paths.directory],
  ["Cursor proxy", `127.0.0.1:${setup.config.port}`],
  ["Codex endpoint", setup.codex ? `https://127.0.0.1:${setup.codex.port}/… (secret path in config.json)` : "Not set up"],
  ["Antigravity endpoint", setup.codex ? `https://127.0.0.1:${setup.codex.port} (shared loopback TLS)` : "Not set up"],
  ["Settings", `${setup.paths.config} (owner only: ports, proxy login, Codex path, client session key)`],
  ["Cursor CA", setup.paths.ca],
  ["Cursor CA SHA-256", setup.ca.fingerprint256],
  ["Cursor certificate", `${setup.paths.certificate} · key ${setup.paths.key}`],
  ["Cursor SPKI pin", `sha256/${setup.tls.spki}`],
  ["Cursor hosts", `${CURSOR_CERTIFICATE_NAMES.length} names: api2.cursor.sh, *.cursor.sh, *.cursor.com, …`],
  ...(setup.codex
    ? ([
        ["Codex CA", setup.paths.codexCa],
        ["Codex CA SHA-256", setup.codex.ca.fingerprint256],
        ["Codex certificate", `${setup.paths.codexCertificate} · key ${setup.paths.codexKey} · 127.0.0.1`],
      ] as const)
    : []),
  ...(setup.antigravityIde ? [
    ["Antigravity IDE proxy", `127.0.0.1:${setup.config.port} (shared HTTP CONNECT)`],
    ["Antigravity IDE CA", setup.paths.antigravityCa],
    ["Antigravity IDE CA SHA-256", setup.antigravityIde.ca.fingerprint256],
    ["Antigravity IDE certificate", `${setup.paths.antigravityCertificate} · key ${setup.paths.antigravityKey}`],
    ["Antigravity IDE SPKI pin", `sha256/${setup.antigravityIde.tls.spki}`],
  ] as const : []),
  ["CA private keys", "Not stored; nothing else can be signed with these CAs"],
  ["Valid until", date(setup.certificate.validTo)],
  ["Log", setup.paths.log],
];

const statusRows = (setup: ProxySetup, status: ProxyStatus): ReadonlyArray<readonly [string, string]> => [
  ["State", `Running · PID ${status.pid} · ${uptime(status.startedAt)}`],
  ["Cursor proxy", `127.0.0.1:${status.port}`],
  ["Codex endpoint", status.codexPort ? `127.0.0.1:${status.codexPort}` : setup.codex ? "Restart to serve Codex" : "Not set up"],
  ["Antigravity", status.antigravity ? "Ready · impact antigravity" : "Restart to add Antigravity"],
  ["Antigravity IDE", status.antigravityIde ? "Ready · impact antigravity" : "Run impact proxy setup, then impact proxy restart"],
  ["Account", status.account?.email ?? (status.login ? "Not loaded yet" : "Not signed in · impact login")],
  ...(status.baseUrl ? [["Endpoint", status.baseUrl] as const] : []),
  ...(status.models !== undefined ? [["Cursor models", String(status.models)] as const] : []),
  ...(status.cursorVersion ? [["Cursor", status.cursorVersion] as const] : []),
  ["Version", status.version],
  ["Log", setup.paths.log],
];

/** Setups from before Codex support gain its endpoint on the next start; nothing else changes. */
const completed = (setup: ProxySetup) =>
  Effect.gen(function* () {
    if (setup.codex && setup.antigravityIde) return setup;
    const next = yield* completeProxySetup(setup);
    yield* (yield* Output).notice("primary", "Added the missing client certificates and endpoints to the proxy setup.");
    return next;
  });

/** Offers to start the proxy after setup; never asks without an interactive terminal. */
const offerStart = (setup: ProxySetup) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const stdio = yield* Stdio.Stdio;
    if ((yield* proxyStatus(setup)) !== undefined) return;
    if (!(yield* stdio.stdinIsTerminal) || !process.stdout.isTTY)
      return yield* output.line("Next: impact proxy start, then impact cursor ., impact codex or impact antigravity");
    const start = yield* Prompt.Confirm({ message: "Start the proxy now?", initial: false }).pipe(
      Effect.catchTag("QuitError", () => Effect.succeed(false)),
    );
    if (!start) return yield* output.line("Start it later with impact proxy start.");
    const { status } = yield* startProxy(setup);
    yield* output.notice("success", "Started in the background.");
    yield* output.rows(statusRows(setup, status));
  });

const versionNotice = (status: ProxyStatus) =>
  Effect.gen(function* () {
    if (status.version !== version)
      yield* (yield* Output).notice(
        "warning",
        `The running proxy is v${status.version}; this CLI is v${version}. Run impact proxy restart.`,
      );
  });

const showStatus = Effect.fn(function* () {
  const output = yield* Output;
  yield* output.start("Impact proxy");
  const setup = yield* readProxySetup;
  if (!setup) return yield* output.notice("warning", "Not set up. Run impact proxy setup.");
  const status = yield* proxyStatus(setup);
  if (!status) {
    yield* output.notice("warning", "Stopped. Start it with impact proxy start.");
    return yield* output.rows([
      ["Proxy", `127.0.0.1:${setup.config.port}`],
      ["Log", setup.paths.log],
    ]);
  }
  yield* output.rows(statusRows(setup, status));
  yield* versionNotice(status);
});

const setup = Command.make(
  "setup",
  {
    port: Flag.Int("port").pipe(Flag.optional, Flag.withDescription("Loopback port; an available one by default")),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace the certificates, ports and proxy login"),
    ),
  },
  Effect.fn(function* ({ port, force }) {
    const output = yield* Output;
    yield* output.start("Impact proxy setup");
    const requested = Option.getOrUndefined(port);
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65_535))
      return yield* new CliError({ message: "Use a proxy port between 1 and 65535." });
    const existing = yield* readProxySetup.pipe(Effect.catchTag("CliError", (error) => (force ? Effect.void : Effect.fail(error))));
    if (existing && !force) {
      const setup = yield* completed(existing);
      if (setup === existing) yield* output.notice("primary", "Already set up. Use --force to create new certificates, ports and login.");
      else if (yield* proxyStatus(setup)) yield* output.notice("warning", "Run impact proxy restart to load the added client support.");
      yield* output.rows(setupRows(setup));
      return yield* offerStart(setup);
    }
    if (existing && (yield* proxyStatus(existing)))
      return yield* new CliError({ message: "Stop the proxy before replacing its setup: impact proxy stop." });
    const created = yield* createProxySetup(requested);
    yield* output.notice("success", existing ? "Replaced the proxy setup. Reopen Impact desktop clients." : "Created the proxy setup.");
    yield* output.rows(setupRows(created));
    yield* output.line(
      "Clients opened by impact cursor, impact codex and impact antigravity trust these CAs: Cursor through NODE_EXTRA_CA_CERTS and the SPKI pin, Codex through CODEX_CA_CERTIFICATE, Antigravity through its gateway CA and the SPKI pin. System trust is unchanged.",
    );
    yield* offerStart(created);
  }),
).pipe(
  Command.withDescription("Create the proxy certificates, ports and login, or add what an older setup lacks"),
  Command.withShortDescription("Create certificates and settings"),
);

const start = Command.make(
  "start",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Start the Impact proxy");
    const setup = yield* completed(yield* requireSetup);
    const { status, started } = yield* startProxy(setup);
    yield* output.notice(started ? "success" : "primary", started ? "Started in the background." : "Already running.");
    yield* output.rows(statusRows(setup, status));
    yield* versionNotice(status);
  }),
).pipe(Command.withDescription("Start the proxy in the background"), Command.withShortDescription("Start in the background"));

const stop = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Stop the Impact proxy");
    const setup = yield* requireSetup;
    const stopped = yield* stopProxy(setup);
    yield* output.notice(
      stopped ? "success" : "primary",
      stopped ? `Stopped PID ${stopped.pid}. Open clients lose AI until it starts again.` : "Not running.",
    );
  }),
).pipe(Command.withDescription("Stop the background proxy"), Command.withShortDescription("Stop"));

const restart = Command.make(
  "restart",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Restart the Impact proxy");
    const setup = yield* completed(yield* requireSetup);
    yield* stopProxy(setup);
    const { status } = yield* startProxy(setup);
    yield* output.notice("success", "Restarted. Clients reconnect on their next request.");
    yield* output.rows(statusRows(setup, status));
  }),
).pipe(
  Command.withDescription("Restart the proxy, for example after the model catalog changes"),
  Command.withShortDescription("Restart"),
);

const status = Command.make("status", {}, showStatus).pipe(
  Command.withDescription("Show whether the proxy runs and what it serves"),
  Command.withShortDescription("Show status"),
);

const run = Command.make("run", {}, serveProxy).pipe(
  Command.withDescription("Run the proxy in the foreground; impact proxy start runs this in the background"),
  Command.withShortDescription("Run in the foreground"),
);

export const proxy = Command.make("proxy", {}, showStatus).pipe(
  Command.withSubcommands([setup, start, stop, restart, status, run]),
  Command.withDescription("Background proxy that connects Cursor, Codex and Antigravity to Impact"),
  Command.withShortDescription("Background proxy for coding clients"),
);

import { Effect, FileSystem } from "effect";
import envPaths from "env-paths";
import { join } from "node:path";

import type { LaunchOptions } from "../Client.ts";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { cursorSession, requireProxy } from "../../proxy/Control.ts";
import { cursorProfileInUse, prepareCursorProfile } from "./Profile.ts";

const RESERVED = ["--test-backend-url", "--user-data-dir", "--reuse-window", "-r", "--proxy-server", "--no-proxy-server", "--proxy-bypass-list", "--proxy-pac-url", "--ignore-certificate-errors", "--ignore-certificate-errors-spki-list", "--override-cursor-auth-token", "--profile"];

/**
 * Opens the installed editor through the running Impact proxy. A fresh instance gets the mirrored,
 * signed-in profile first; while one runs, the editor forwards the arguments to it as a new window.
 */
export const prepareCursor = Effect.fn("prepareCursor")(
  function* ({ executable, args, connection }: LaunchOptions) {
    if (/[\\/](?:\.cursor-server|remote-cli)[\\/]/.test(executable))
      return yield* new CliError({ message: "Run impact cursor on the computer with Cursor Desktop installed; the remote CLI cannot configure Desktop Tab." });
    if (args.some((arg) => RESERVED.some((name) => arg === name || arg.startsWith(`${name}=`))))
      return yield* new CliError({ message: "Impact supplies Cursor's backend and profile. Use IMPACT_CURSOR_USER_DATA_DIR to select a profile." });
    const { setup } = yield* requireProxy(connection);
    const directory = process.env.IMPACT_CURSOR_USER_DATA_DIR ?? join(process.env.IMPACT_CONFIG_DIR ?? envPaths("impact", { suffix: "" }).config, "cursor", "profile");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const running = yield* cursorProfileInUse(directory);
    if (!running) {
      const session = yield* cursorSession(setup);
      yield* prepareCursorProfile(directory, session.account, session.modelIds);
    }
    // Node transports trust the proxy CA in addition to any roots the user already adds.
    let certificateFile = setup.tls.certificateFile;
    if (process.env.NODE_EXTRA_CA_CERTS) {
      certificateFile = join(directory, "impact-roots.pem");
      const extra = yield* fs.readFileString(process.env.NODE_EXTRA_CA_CERTS);
      yield* fs.writeFileString(certificateFile, `${extra}\n${setup.ca.toString()}\n`, { mode: 0o600 });
    }
    const { port, username, password } = setup.config;
    const proxyUrl = `http://${username}:${password}@127.0.0.1:${port}`;
    const { IMPACT_API_KEY: _key, IMPACT_LAUNCH_CWD: _cwd, VSCODE_IPC_HOOK_CLI: _ipc, ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
    return {
      // Cursor's parser gives an unknown bare flag the next operand as its value, so the bare
      // --disable-http2 must precede the --name=value flags.
      args: ["--user-data-dir", directory, "--disable-http2", `--ignore-certificate-errors-spki-list=${setup.tls.spki}`, `--proxy-server=http://127.0.0.1:${port}`, ...args],
      env: {
        ...env,
        HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
        NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
        NODE_EXTRA_CA_CERTS: certificateFile,
      },
      detach: { log: join(directory, "impact-cursor.log"), append: running },
    };
  },
  mapPlatformError("Cannot prepare the Cursor profile"),
);

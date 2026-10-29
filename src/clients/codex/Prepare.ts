import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { omit } from "es-toolkit";

import { fetchUsage } from "../../api/Usage.ts";
import { CliError, mapPlatformError } from "../../Errors.ts";
import { clientEnvironment, type LaunchOptions } from "../Client.ts";
import { impactCodexAuth } from "./Auth.ts";
import { configureCodex } from "./Config.ts";
import { requireProxy } from "../../proxy/Control.ts";
import { enabledMcpServers } from "../../config/Mcp.ts";
import { codexMcpServers } from "../../setup/Mcp.ts";
import { DEFAULT_MODEL } from "../../setup/Models.ts";
import { codexModels } from "./Models.ts";
import { codexCaBundle } from "./Tls.ts";

/** Runs Codex against the background proxy's loopback endpoint; Codex never sees the Impact key. */
export const prepareCodex = Effect.fn("prepareCodex")(function* ({ executable, args, connection }: LaunchOptions) {
  const { setup, status } = yield* requireProxy(connection);
  if (!setup.codex) return yield* new CliError({ message: "Add Codex to the proxy: impact proxy setup, then impact proxy restart." });
  if (status.codexPort !== setup.codex.port)
    return yield* new CliError({ message: "The running proxy does not serve Codex yet. Run impact proxy restart." });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionText = yield* spawner
    .string(ChildProcess.make(executable, ["--version"]))
    .pipe(mapPlatformError("Cannot run codex --version"));
  const version = /\b\d+\.\d+\.\d+\b/.exec(versionText)?.[0] ?? "0";
  const catalog = yield* codexModels(connection, version);
  const requested = process.env.IMPACT_MODEL;
  const model =
    catalog.models.find((model) => model.slug === (requested ?? DEFAULT_MODEL)) ??
    (requested ? undefined : catalog.models[0]);
  if (!model)
    return yield* new CliError({
      message: requested ? `Model ${requested} is unavailable in Impact.` : "Impact has no enabled models.",
    });
  const account = yield* impactCodexAuth(yield* fetchUsage(connection));
  const certificateFile = yield* codexCaBundle(setup.codex.ca.toString());
  const appServer = args[0] === "app-server";
  const mcp = codexMcpServers(yield* enabledMcpServers, setup.codex.baseUrl);
  const profile = yield* configureCodex(
    model.slug,
    catalog,
    setup.codex.baseUrl,
    account.directory,
    appServer ? "home" : "profile",
    mcp,
  );
  // The stdio server has no --profile option; keep its secret proxy URL in its isolated config file.
  const clientArgs = appServer ? [] : ["--no-daemon", "--profile", profile.name];
  return {
    args: [...clientArgs, ...args],
    env: {
      ...omit(clientEnvironment(connection), [
        "IMPACT_API_KEY",
        "IMPACT_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
      ]),
      CODEX_HOME: account.directory,
      CODEX_CA_CERTIFICATE: certificateFile,
    },
  };
});

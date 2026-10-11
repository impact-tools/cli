import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { omit } from "es-toolkit";

import { fetchUsage } from "../../api/Usage.ts";
import { CliError, mapPlatformError } from "../../Errors.ts";
import { clientEnvironment, type LaunchOptions } from "../Client.ts";
import { impactCodexAuth } from "./Auth.ts";
import { configureCodex } from "./Config.ts";
import { codexModels } from "./Models.ts";
import { codexProxy } from "./Proxy.ts";

export const prepareCodex = Effect.fn("prepareCodex")(function* ({ executable, args, connection }: LaunchOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionText = yield* spawner
    .string(ChildProcess.make(executable, ["--version"]))
    .pipe(mapPlatformError("Cannot run codex --version"));
  const version = /\b\d+\.\d+\.\d+\b/.exec(versionText)?.[0] ?? "0";
  const catalog = yield* codexModels(connection, version);
  const requested = process.env.IMPACT_MODEL;
  const model =
    catalog.models.find((model) => model.slug === (requested ?? "gpt-6.1-sol")) ??
    (requested ? undefined : catalog.models[0]);
  if (!model)
    return yield* new CliError({
      message: requested ? `Model ${requested} is unavailable in Impact.` : "Impact has no enabled models.",
    });
  const account = yield* impactCodexAuth(yield* fetchUsage(connection));
  const proxy = yield* codexProxy(connection, account.accountId);
  // The stdio server has no --profile option, so its config is the launch home's own config.toml.
  const appServer = args[0] === "app-server";
  const profile = yield* configureCodex(
    model.slug,
    catalog,
    proxy.baseUrl,
    account.directory,
    appServer ? "home" : "profile",
  );
  const clientArgs = appServer ? [] : ["--no-daemon", "--profile", profile.name];
  return {
    args: [...clientArgs, ...args],
    env: {
      ...omit(clientEnvironment(connection), [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
      ]),
      CODEX_HOME: account.directory,
      CODEX_CA_CERTIFICATE: proxy.certificateFile,
    },
  };
});

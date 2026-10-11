#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CliOutput, Command, Prompt } from "effect/cli";

import { version } from "../package.json";
import * as Http from "./api/Http.ts";
import { checkForUpdate } from "./api/Update.ts";
import { command } from "./Command.ts";
import { clientArguments } from "./commands/Client.ts";
import { welcomeAccount } from "./ui/Account.ts";
import { makeFormatter } from "./ui/Help.ts";
import { makeOutput, Output } from "./ui/Output.ts";
import { promptTheme } from "./ui/Theme.ts";
import { welcome } from "./ui/Welcome.ts";

if (process.env.IMPACT_LAUNCH_CWD) process.chdir(process.env.IMPACT_LAUNCH_CWD);

/**
 * Closing the terminal or IDE sends SIGHUP, which the runtime leaves alone; stopping as on Ctrl+C
 * lets the launch remove its temporary Codex home and status files.
 */
const interruptOnHangup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.withFiber<A, E, R>((fiber) => {
    const hangup = () => fiber.interruptUnsafe(fiber.id);
    process.on("SIGHUP", hangup);
    return effect.pipe(Effect.ensuring(Effect.sync(() => process.off("SIGHUP", hangup))));
  });

Effect.suspend(() => {
  const output = makeOutput();
  // Helpers and native clients never enter a branded screen; only human output requests a banner.
  const args = clientArguments(process.argv.slice(2));
  const updateCheck =
    process.stdout.isTTY === true &&
    process.env.IMPACT_DISABLE_UPDATE_CHECK !== "1" &&
    !args.some((arg) => ["--help", "-h", "--version", "-v", "--completions"].includes(arg))
      ? checkForUpdate(version).pipe(
          Effect.flatMap((update) =>
            update._tag === "Some"
              ? output.notice(
                  "primary",
                  `New version available: v${update.value.current} → v${update.value.latest}. Update with npm install --global @impact-relay/cli.`,
                )
              : Effect.void,
          ),
          Effect.catch(() => Effect.void),
        )
      : Effect.void;
  const run =
    args.length === 0
      ? welcomeAccount.pipe(Effect.flatMap((account) => Console.log(welcome(command, output, account))))
      : Command.runWith(command, { version })(args);
  return interruptOnHangup(
    updateCheck.pipe(
      Effect.andThen(run),
      Effect.catchTag("CliError", (error) =>
        Console.error(output.error(error.message)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
      Effect.provide([NodeServices.layer, Http.layer, CliOutput.layer(makeFormatter(output))]),
      Effect.provideService(Output, output),
      Effect.provideService(Prompt.Theme, promptTheme(output.stdout)),
    ),
  );
}).pipe(NodeRuntime.runMain);

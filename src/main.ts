#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CliOutput, Command, Prompt } from "effect/cli";

import { version } from "../package.json";
import * as Http from "./api/Http.ts";
import { command } from "./Command.ts";
import { clientArguments } from "./commands/Client.ts";
import { welcomeAccount } from "./ui/Account.ts";
import { makeFormatter } from "./ui/Help.ts";
import { makeOutput, Output } from "./ui/Output.ts";
import { promptTheme } from "./ui/Theme.ts";
import { welcome } from "./ui/Welcome.ts";

if (process.env.IMPACT_LAUNCH_CWD) process.chdir(process.env.IMPACT_LAUNCH_CWD);

Effect.suspend(() => {
  const output = makeOutput();
  // Helpers and native clients never enter a branded screen; only human output requests a banner.
  const args = clientArguments(process.argv.slice(2));
  const run =
    args.length === 0
      ? welcomeAccount.pipe(Effect.flatMap((account) => Console.log(welcome(command, output, account))))
      : Command.runWith(command, { version })(args);
  return run.pipe(
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
  );
}).pipe(NodeRuntime.runMain);

import { Effect } from "effect";
import { Command } from "effect/cli";

import { countModels } from "../api/Models.ts";
import { findExecutable } from "../clients/Client.ts";
import { CLIENTS } from "../clients/Launch.ts";
import { configDirectory, currentConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

type Row = readonly [string, string];

/**
 * What Impact says about the login this machine would use. No login, a broken one or an unreachable
 * endpoint is a row, not a failure: the config folder and the clients must show in every state.
 */
const connectionRows = currentConnection.pipe(
  Effect.flatMap((connection) =>
    countModels(connection).pipe(
      Effect.map((models): ReadonlyArray<Row> => [
        ["Impact", connection.baseUrl],
        ["Models", String(models)],
      ]),
    ),
  ),
  Effect.catchTag("CliError", (error) => Effect.succeed<ReadonlyArray<Row>>([["Connection", error.message]])),
);

export const doctor = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Setup check");
    yield* output.rows([["Config folder", configDirectory()], ...(yield* connectionRows)]);
    yield* output.section("Clients");
    const clientRows: Array<Row> = [];
    const plainLines: string[] = [];
    for (const name of CLIENTS) {
      const executable = findExecutable(name);
      clientRows.push([executable ? `${name} (installed)` : name, executable ?? "not installed"]);
      plainLines.push(`${name}: ${executable ?? "not installed"}`);
    }
    yield* output.rows(clientRows, plainLines.join("\n"));
  }),
).pipe(Command.withDescription("Show the config folder, check the Impact connection and installed clients"));

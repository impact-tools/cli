import { Effect } from "effect";
import { Command } from "effect/cli";

import { countModels } from "../api/Models.ts";
import { findExecutable } from "../clients/Client.ts";
import { CLIENTS } from "../clients/Launch.ts";
import { currentConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

export const doctor = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Connection check");
    const connection = yield* currentConnection;
    const models = yield* countModels(connection);
    yield* output.rows([
      ["Impact", connection.baseUrl],
      ["Models", String(models)],
    ]);
    yield* output.section("Clients");
    const clientRows: Array<readonly [string, string]> = [];
    const plainLines: string[] = [];
    for (const name of CLIENTS) {
      const executable = findExecutable(name);
      clientRows.push([executable ? `${name} (installed)` : name, executable ?? "not installed"]);
      plainLines.push(`${name}: ${executable ?? "not installed"}`);
    }
    yield* output.rows(clientRows, plainLines.join("\n"));
  }),
).pipe(Command.withDescription("Check the Impact connection and installed clients"));

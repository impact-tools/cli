import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { cursorProxy } from "../clients/cursor/Proxy.ts";
import { currentConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

export const proxy = Command.make(
  "proxy",
  {
    port: Flag.Int("port").pipe(
      Flag.withDefault(0),
      Flag.withDescription("Loopback port; 0 chooses an available port"),
    ),
  },
  Effect.fn(function* ({ port }) {
    const connection = yield* currentConnection;
    const local = yield* cursorProxy(connection, { port });
    const output = yield* Output;
    yield* output.rows([
      ["Proxy", local.baseUrl],
      ["OpenAI base URL", `${local.baseUrl}/v1`],
      ["Cursor backend", local.baseUrl],
    ]);
    yield* output.line("Keep this terminal open. Ctrl+C stops the proxy.");
    yield* Effect.never;
  }, Effect.scoped),
).pipe(
  Command.withDescription("Serve Impact API and native Cursor Tab through a local backend"),
  Command.withShortDescription("Local API and Cursor Tab backend"),
);

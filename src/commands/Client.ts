import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { clients, isClient, launch, type Client } from "../clients/Launch.ts";
import { currentConnection } from "../config/Credentials.ts";

const OFFLINE = ["--help", "-h", "--version", "-v"];

export const clientCommand = (name: Client) =>
  Command.make(
    name,
    { args: Argument.String("client-args").pipe(Argument.variadic()) },
    Effect.fn(function* ({ args }) {
      const offline = args.length === 1 && OFFLINE.includes(args[0]!);
      yield* launch(name, args, offline ? undefined : yield* currentConnection);
    }),
  ).pipe(
    Command.withDescription(`Run ${clients[name].label} through Impact; all arguments go to the client`),
    Command.withShortDescription(clients[name].label),
  );

// Native clients own their flags; the separator tells Effect CLI to collect them as operands.
export const clientArguments = (args: readonly string[]) => {
  const client = args[0];
  return client !== undefined && isClient(client)
    ? [client, "--", ...(args[1] === "--" ? args.slice(2) : args.slice(1))]
    : args;
};

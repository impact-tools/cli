import { Console, Effect, Redacted } from "effect";
import { Command } from "effect/cli";

import { renderStatusLine } from "../clients/claude/StatusLine.ts";
import { currentConnection } from "../config/Credentials.ts";

const printToken = () =>
  currentConnection.pipe(Effect.flatMap((connection) => Console.log(Redacted.value(connection.apiKey))));

const token = Command.make("token", {}, printToken).pipe(
  Command.withDescription("Print the API key, for Claude's apiKeyHelper"),
);

const statusLine = Command.make("status-line", {}, () => Effect.sync(renderStatusLine)).pipe(
  Command.withDescription("Render Claude's status line from the launch snapshot"),
);

/** Commands that clients run during an Impact launch. */
export const helper = Command.make("helper").pipe(
  Command.withSubcommands([token, statusLine]),
  Command.withDescription("Commands run by clients during an Impact launch"),
  Command.unlisted,
);

/** `impact auth token`, which Claude sessions launched by earlier versions still call. */
export const legacyAuth = Command.make("auth").pipe(
  Command.withSubcommands([Command.make("token", {}, printToken)]),
  Command.unlisted,
);

import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { fetchSpend } from "../api/Spend.ts";
import { fetchUsage, usageSummary, walletBalance } from "../api/Usage.ts";
import { renderStatusLine } from "../clients/claude/StatusLine.ts";
import { currentConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

export const status = Command.make(
  "status",
  // `--claude` is the status line command of sessions launched by earlier versions; new ones use `helper status-line`.
  { claude: Flag.Boolean("claude").pipe(Flag.withHidden, Flag.withDefault(false)) },
  Effect.fn(function* ({ claude }) {
    if (claude) return renderStatusLine();
    const output = yield* Output;
    yield* output.start("Account status");
    const connection = yield* currentConnection;
    const usage = yield* fetchUsage(connection);
    const held: ReadonlyArray<readonly [string, string]> =
      usage.credits.reserved === undefined ? [] : [["Held", `$${usage.credits.reserved} USD`]];
    yield* output.rows(
      [
        ["Account", usage.account?.email ?? connection.baseUrl],
        ["Credits", `$${walletBalance(usage)} USD`],
        ...held,
        ["Available", `$${usage.credits.balance} USD`],
        ["Endpoint", connection.baseUrl],
      ],
      [
        usageSummary(connection, usage),
        ...held.map(([name, value]) => `${name}: ${value}`),
        `Available: $${usage.credits.balance} USD`,
        `Endpoint: ${connection.baseUrl}`,
      ].join("\n"),
    );
    const spend = yield* fetchSpend(connection).pipe(Effect.orElseSucceed(() => undefined));
    yield* output.spend(spend);
  }),
).pipe(Command.withDescription("Show your Impact wallet balance and spending"));

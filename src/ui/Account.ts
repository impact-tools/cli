import { Effect, Option } from "effect";

import type { WelcomeAccount } from "./Welcome.ts";

import { fetchUsage, usageSummary } from "../api/Usage.ts";
import { currentConnection } from "../config/Credentials.ts";

// Only the bare landing screen reads this optional summary; helpers and help never make this request.
export const welcomeAccount = Effect.gen(function* () {
  const connection = yield* currentConnection.pipe(
    Effect.timeoutOption("300 millis"),
    Effect.catchTag("CliError", () => Effect.succeedNone),
  );
  if (Option.isNone(connection)) return { state: "guest" } satisfies WelcomeAccount;
  const usage = yield* fetchUsage(connection.value, "1200 millis").pipe(
    Effect.map((value) => usageSummary(connection.value, value)),
    Effect.catchTag("CliError", () => Effect.succeed("Balance unavailable · impact status")),
  );
  return { state: "connected", summary: usage } satisfies WelcomeAccount;
});

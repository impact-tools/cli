import { Effect, Redacted, Stdio, Stream } from "effect";
import { Prompt } from "effect/cli";

import { apiKey } from "../config/Connection.ts";
import { CliError, mapPlatformError } from "../Errors.ts";

export const readKey = Effect.fn("readKey")(function* (fromStdin: boolean) {
  const stdio = yield* Stdio.Stdio;
  if (fromStdin)
    return yield* apiKey(
      yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString, mapPlatformError("Cannot read the key from stdin")),
    );
  if (process.env.IMPACT_API_KEY) return yield* apiKey(process.env.IMPACT_API_KEY);
  if (!(yield* stdio.stdinIsTerminal))
    return yield* new CliError({ message: "Use --key-stdin, or set IMPACT_API_KEY." });
  return yield* apiKey(Redacted.value(yield* Prompt.Password({ message: "Impact API key" })));
});

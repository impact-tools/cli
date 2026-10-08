import { Effect, PlatformError, Schema } from "effect";

/** The only failure `main` prints: one line, exit code 1. */
export class CliError extends Schema.TaggedError<CliError>()("CliError", { message: Schema.String }) {}

/** Reports a filesystem or process failure as a `CliError` with its own context. */
export const mapPlatformError =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      self,
      (error): error is E & PlatformError.PlatformError => PlatformError.isPlatformError(error),
      (error) => Effect.fail(new CliError({ message: `${message} (${error.message})` })),
    );

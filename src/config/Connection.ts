import { Effect, Schema } from "effect";

import { CliError } from "../Errors.ts";

export const DEFAULT_BASE_URL = "https://api.impact-relay.com";

const ApiKey = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^sk-imp-[0-9A-Za-z]{43}$/)));
export const Connection = Schema.Struct({
  baseUrl: Schema.String,
  apiKey: ApiKey,
  /**
   * Set when `impact login` created the key through the browser: the CLI revokes that key when a new
   * login replaces it or on `impact logout`. A pasted key has none and is never revoked.
   */
  createdKey: Schema.optional(Schema.Struct({ id: Schema.String })),
});
export type Connection = typeof Connection.Type;

const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");

/** Impact's origin: credentials, query, fragment and paths such as `/v1` are dropped. */
export const baseUrl = (input: string) => {
  const url = URL.parse(input);
  return url?.protocol === "https:" || (url?.protocol === "http:" && loopback(url.hostname))
    ? Effect.succeed(url.origin)
    : Effect.fail(new CliError({ message: "Use an HTTPS Impact URL, or HTTP on localhost for development." }));
};

export const apiKey = (input: string) =>
  Schema.decodeEffect(ApiKey)(input.trim()).pipe(
    Effect.mapError(() => new CliError({ message: "Enter an Impact API key (sk-imp-…)." })),
  );

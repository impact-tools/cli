import { Effect, Schema } from "effect";

import { CliError } from "../Errors.ts";

export const DEFAULT_BASE_URL = "https://api.impact-relay.com";

/**
 * Origins Impact answered on before it moved. They name the same service under its old address, and
 * nothing answers there any more: a login saved for one belongs to the current origin, and so does
 * a new one, so nobody who signed in back then has to learn about the move.
 */
const RETIRED_BASE_URLS: ReadonlySet<string> = new Set(["https://api.impactllm.com"]);

/** The origin Impact answers on now, for an origin it used to answer on. */
export const currentOrigin = (origin: string) => (RETIRED_BASE_URLS.has(origin) ? DEFAULT_BASE_URL : origin);

const ApiKey = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^sk-imp-[0-9A-Za-z]{43}$/)));
export const Connection = Schema.Struct({
  baseUrl: Schema.String,
  apiKey: ApiKey,
  /** Browser-created keys are revoked when a login replaces or removes them. */
  createdKey: Schema.optional(Schema.Struct({ id: Schema.String })),
});
export type Connection = typeof Connection.Type;

const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");

/** Impact's origin: credentials, query, fragment and paths such as `/v1` are dropped, and a retired origin becomes the current one. */
export const baseUrl = (input: string) => {
  const url = URL.parse(input);
  return url?.protocol === "https:" || (url?.protocol === "http:" && loopback(url.hostname))
    ? Effect.succeed(currentOrigin(url.origin))
    : Effect.fail(new CliError({ message: "Use an HTTPS Impact URL, or HTTP on localhost for development." }));
};

export const apiKey = (input: string) =>
  Schema.decodeEffect(ApiKey)(input.trim()).pipe(
    Effect.mapError(() => new CliError({ message: "Enter an Impact API key (sk-imp-…)." })),
  );

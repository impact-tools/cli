import { Effect, Layer, type Duration, type Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { Connection } from "../config/Connection.ts";

import { version } from "../../package.json";
import { CliError } from "../Errors.ts";

export const CLI_VERSION: string = version;
/** Every direct call names the CLI release, so Impact can tell which versions are still in use. */
export const USER_AGENT = `impact-cli/${CLI_VERSION} (${process.platform}; ${process.arch})`;
/** The proxies keep the coding client's own user-agent and add the CLI release beside it. */
export const VERSION_HEADER = "x-impact-cli-version";

/**
 * Impact never redirects API calls; following one could send the key to another host. A request
 * that names its own user-agent (the npm update check) keeps it.
 */
export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest((request) =>
      request.headers["user-agent"] ? request : HttpClientRequest.setHeader(request, "user-agent", USER_AGENT),
    ),
  ),
).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "error" })),
);

export interface GetJsonOptions {
  /** Shown when the response does not match the schema. */
  readonly invalid: string;
  readonly headers?: Record<string, string> | undefined;
  readonly timeout?: Duration.Input | undefined;
}

/** An authenticated GET against Impact, decoded with `schema`. */
export const getJson = Effect.fnUntraced(
  function* <S extends Schema.Top>(
    connection: Connection,
    path: string,
    schema: S,
    { invalid, headers }: GetJsonOptions,
  ) {
    const response = yield* HttpClientRequest.get(`${connection.baseUrl}${path}`, { headers }).pipe(
      HttpClientRequest.bearerToken(connection.apiKey),
      HttpClient.execute,
    );
    if (response.status === 401 || response.status === 403)
      return yield* new CliError({ message: "Impact rejected this API key." });
    if (response.status >= 400)
      return yield* new CliError({ message: `Impact returned HTTP ${response.status}. Try again later.` });
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new CliError({ message: invalid })),
    );
  },
  (effect, connection, _path, _schema, { timeout = "10 seconds" }) =>
    effect.pipe(
      Effect.timeout(timeout),
      Effect.catchTag(["HttpClientError", "TimeoutError"], () =>
        Effect.fail(
          new CliError({
            message: `Cannot reach Impact at ${connection.baseUrl}. Check the URL, network, and TLS certificate.`,
          }),
        ),
      ),
    ),
);

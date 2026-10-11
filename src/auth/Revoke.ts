import { Effect, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Output } from "../ui/Output.ts";

/** Where a key the CLI could not revoke is revoked by hand. */
export const apiKeysPage = (baseUrl: string) => `${baseUrl}/api-keys`;

/**
 * Revokes a key with its own secret. 204 means revoked; 401 means Impact no longer accepts the
 * key, which is the outcome asked for. Returns whether the key is gone.
 */
export const revokeOwnKey = Effect.fnUntraced(
  function* (baseUrl: string, secret: Redacted.Redacted<string>) {
    const response = yield* HttpClientRequest.post(`${baseUrl}/v1/keys/self/revoke`).pipe(
      HttpClientRequest.bearerToken(secret),
      HttpClient.execute,
    );
    return (response.status >= 200 && response.status < 300) || response.status === 401;
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag(["HttpClientError", "TimeoutError"], () => Effect.succeed(false)),
    ),
);

/** Revokes the key, or warns where to revoke it: signing in or out never fails on this step. */
export const revokeOrWarn = Effect.fnUntraced(function* (
  baseUrl: string,
  secret: Redacted.Redacted<string>,
  warning: string,
) {
  if (yield* revokeOwnKey(baseUrl, secret)) return true;
  const output = yield* Output;
  yield* output.notice("warning", `${warning} Revoke it on ${apiKeysPage(baseUrl)}.`);
  return false;
});

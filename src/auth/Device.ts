import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { hostname } from "node:os";
import open from "open";

import { USER_AGENT } from "../api/Http.ts";
import { apiKey, type Connection } from "../config/Connection.ts";
import { CliError } from "../Errors.ts";
import { DEFAULT_FUNDING } from "../schemas/Billing.ts";
import { ImpactRpcs } from "../schemas/Rpcs.ts";
import { Output } from "../ui/Output.ts";
import { withProgress } from "../ui/Progress.ts";
import { revokeOrWarn } from "./Revoke.ts";

export const CLIENT_ID = "impact-cli";
const grantType = "urn:ietf:params:oauth:grant-type:device_code";

export const createDeviceClient = (baseUrl: string) =>
  createAuthClient({
    baseURL: `${baseUrl}/api/auth`,
    plugins: [deviceAuthorizationClient()],
    fetchOptions: { redirect: "error", timeout: 15_000, headers: { "user-agent": USER_AGENT } },
  });

/** Names the endpoint, so a login that fails against a stale one says so instead of leaving the user guessing. */
const unreachable = (baseUrl?: string) => () => {
  const where = baseUrl === undefined ? "" : ` at ${baseUrl}`;
  return new CliError({
    message: `Cannot reach Impact${where} to authorize this device. Check the URL, network, and TLS certificate.`,
  });
};
const expired = () => new CliError({ message: "The device code expired. Run impact login again." });

export const waitForDeviceToken = Effect.fn("waitForDeviceToken")(
  function* (
    client: ReturnType<typeof createDeviceClient>,
    code: { device_code: string; expires_in: number; interval?: number | undefined },
    baseUrl?: string,
  ) {
    let interval = Math.max(1, code.interval ?? 5);
    while (true) {
      yield* Effect.sleep(`${interval} seconds`);
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          client.device.token(
            { grant_type: grantType, device_code: code.device_code, client_id: CLIENT_ID },
            { signal },
          ),
        catch: unreachable(baseUrl),
      });
      if (result.data?.access_token) return result.data.access_token;
      switch (result.error?.error) {
        case "authorization_pending":
          break;
        case "slow_down":
          interval += 5;
          break;
        case "access_denied":
          return yield* new CliError({ message: "Device authorization was denied." });
        case "expired_token":
          return yield* expired();
        default:
          return yield* new CliError({ message: result.error?.error_description ?? "Device authorization failed." });
      }
    }
  },
  (effect, _client, code, _baseUrl?: string | undefined) =>
    effect.pipe(Effect.timeoutOrElse({ duration: code.expires_in * 1000, orElse: () => Effect.fail(expired()) })),
);

const createApiKey = Effect.fnUntraced(
  function* (_baseUrl: string, _session: string) {
    const rpc = yield* RpcClient.make(ImpactRpcs);
    const created = yield* rpc.ApiKeysCreate({
      name: `Impact CLI (${hostname()})`,
      monthlyLimitMicros: null,
      funding: [...DEFAULT_FUNDING],
    });
    return { id: created.key.id, secret: created.secret };
  },
  Effect.scoped,
  (effect, baseUrl, session) =>
    Effect.provide(
      effect,
      RpcClient.layerProtocolHttp({
        url: `${baseUrl}/rpc`,
        transformClient: HttpClient.mapRequest((request) =>
          request.pipe(HttpClientRequest.bearerToken(session), HttpClientRequest.setHeader("user-agent", USER_AGENT)),
        ),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  Effect.mapError((error) => new CliError({ message: `Impact could not create an API key: ${error.message}` })),
  (effect, baseUrl) =>
    effect.pipe(
      Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(unreachable(baseUrl)()) }),
    ),
);

/**
 * Signs this device in and creates its key, then hands the connection to `keep` while the device
 * session is still open. When the connection cannot be kept, the new key revokes itself before the
 * session signs out, so a failed login leaves no live key behind.
 */
export const deviceLogin = Effect.fn("deviceLogin")(function* <A, E, R>(
  baseUrl: string,
  noBrowser: boolean,
  keep: (connection: Connection) => Effect.Effect<A, E, R>,
) {
  const client = createDeviceClient(baseUrl);
  const requested = yield* Effect.tryPromise({
    try: (signal) => client.device.code({ client_id: CLIENT_ID }, { signal }),
    catch: unreachable(baseUrl),
  });
  if (!requested.data)
    return yield* new CliError({
      message: requested.error?.error_description ?? "Could not start device authorization.",
    });
  const code = requested.data;
  const verifyUrl = new URL(code.verification_uri_complete || code.verification_uri, baseUrl);
  if (verifyUrl.origin !== new URL(baseUrl).origin)
    return yield* new CliError({ message: "Impact returned a verification URL on another origin." });
  const output = yield* Output;
  if (output.stdout.decorative) {
    yield* output.notice("primary", "Open this URL in your browser to sign in:");
    yield* output.line(verifyUrl.href);
    yield* output.rows([["Confirm code", code.user_code]]);
  } else {
    yield* output.line(`Open ${verifyUrl.href}\nConfirm code: ${code.user_code}`);
  }
  if (!noBrowser)
    yield* Effect.tryPromise(() => open(verifyUrl.href)).pipe(
      Effect.catch(() => output.notice("warning", "Open the URL above in your browser to continue.")),
    );
  const session = yield* withProgress("Waiting for approval…", waitForDeviceToken(client, code, baseUrl));
  return yield* createApiKey(baseUrl, session).pipe(
    Effect.flatMap((created) =>
      apiKey(Redacted.value(created.secret)).pipe(
        Effect.flatMap((secret) => keep({ baseUrl, apiKey: secret, createdKey: { id: created.id } })),
        Effect.onError(() =>
          revokeOrWarn(baseUrl, created.secret, "The login failed after Impact created its key.").pipe(Effect.ignore),
        ),
      ),
    ),
    Effect.ensuring(
      Effect.tryPromise(() => client.signOut({}, { headers: { authorization: `Bearer ${session}` } })).pipe(
        Effect.ignore,
      ),
    ),
  );
});

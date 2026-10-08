import { DEFAULT_FUNDING, ImpactRpcs } from "@impact-llm/schemas";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { hostname } from "node:os";
import open from "open";

import { apiKey, type Connection } from "../config/Connection.ts";
import { CliError } from "../Errors.ts";
import { Output } from "../ui/Output.ts";
import { withProgress } from "../ui/Progress.ts";

export const CLIENT_ID = "impact-cli";
const grantType = "urn:ietf:params:oauth:grant-type:device_code";

export const createDeviceClient = (baseUrl: string) =>
  createAuthClient({
    baseURL: `${baseUrl}/api/auth`,
    plugins: [deviceAuthorizationClient()],
    fetchOptions: { redirect: "error", timeout: 15_000 },
  });

const unreachable = () => new CliError({ message: "Cannot reach Impact to authorize this device." });
const expired = () => new CliError({ message: "The device code expired. Run impact login again." });

export const waitForDeviceToken = Effect.fn("waitForDeviceToken")(
  function* (
    client: ReturnType<typeof createDeviceClient>,
    code: { device_code: string; expires_in: number; interval?: number | undefined },
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
        catch: unreachable,
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
  (effect, _client, code) =>
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
    return created.secret;
  },
  Effect.scoped,
  (effect, baseUrl, session) =>
    Effect.provide(
      effect,
      RpcClient.layerProtocolHttp({
        url: `${baseUrl}/rpc`,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(session)),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  Effect.mapError((error) => new CliError({ message: `Impact could not create an API key: ${error.message}` })),
  Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(unreachable()) }),
);

export const deviceLogin = Effect.fn("deviceLogin")(function* (baseUrl: string, noBrowser: boolean) {
  const client = createDeviceClient(baseUrl);
  const requested = yield* Effect.tryPromise({
    try: (signal) => client.device.code({ client_id: CLIENT_ID }, { signal }),
    catch: unreachable,
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
  const session = yield* withProgress("Waiting for approval…", waitForDeviceToken(client, code));
  const key = yield* createApiKey(baseUrl, session).pipe(
    Effect.ensuring(
      Effect.tryPromise(() => client.signOut({}, { headers: { authorization: `Bearer ${session}` } })).pipe(
        Effect.ignore,
      ),
    ),
  );
  return { baseUrl, apiKey: yield* apiKey(Redacted.value(key)) } satisfies Connection;
});

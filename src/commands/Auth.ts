import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { countModels } from "../api/Models.ts";
import { readKey } from "../auth/ApiKey.ts";
import { deviceLogin } from "../auth/Device.ts";
import { readConnection, removeConnection, resolveEndpoint, saveConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

export const login = Command.make(
  "login",
  {
    endpoint: Flag.String("base-url").pipe(Flag.optional),
    noBrowser: Flag.Boolean("no-browser").pipe(Flag.withDefault(false)),
    apiKey: Flag.Boolean("api-key").pipe(Flag.withDefault(false)),
    keyStdin: Flag.Boolean("key-stdin").pipe(Flag.withDefault(false)),
  },
  Effect.fn(function* (options) {
    const output = yield* Output;
    yield* output.start("Sign in");
    const override = Option.getOrUndefined(options.endpoint) ?? process.env.IMPACT_BASE_URL;
    const saved = override === undefined ? yield* readConnection : undefined;
    const endpoint = yield* resolveEndpoint(saved, override);
    const connection =
      options.apiKey || options.keyStdin
        ? { baseUrl: endpoint, apiKey: yield* readKey(options.keyStdin) }
        : yield* deviceLogin(endpoint, options.noBrowser);
    const models = yield* countModels(connection);
    yield* saveConnection(connection);
    if (output.stdout.decorative) {
      yield* output.notice("success", "Signed in to Impact.");
      yield* output.rows([
        ["Endpoint", endpoint],
        ["Models", `${models} available`],
      ]);
    } else {
      yield* output.line(`Signed in to ${endpoint}. ${models} models available.`);
    }
  }),
).pipe(Command.withDescription("Sign in through your browser, or import an API key"));

export const logout = Command.make(
  "logout",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("Sign out");
    yield* removeConnection;
    yield* output.notice("success", "Removed the saved Impact login. Manage or revoke API keys in the web app.");
  }),
).pipe(Command.withDescription("Remove the saved Impact login"));

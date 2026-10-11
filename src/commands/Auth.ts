import { Effect, Option, Redacted } from "effect";
import { Command, Flag } from "effect/cli";

import type { Connection } from "../config/Connection.ts";

import { countModels } from "../api/Models.ts";
import { readKey } from "../auth/ApiKey.ts";
import { deviceLogin } from "../auth/Device.ts";
import { apiKeysPage, revokeOrWarn } from "../auth/Revoke.ts";
import { readConnection, removeConnection, resolveEndpoint, saveConnection } from "../config/Credentials.ts";
import { Output } from "../ui/Output.ts";

const sameKey = (left: Connection, right: Connection) =>
  left.baseUrl === right.baseUrl && Redacted.value(left.apiKey) === Redacted.value(right.apiKey);

/** Saves the connection once Impact accepts its key; returns the number of models. */
const keep = (connection: Connection) => countModels(connection).pipe(Effect.tap(() => saveConnection(connection)));

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
    // The login this one replaces, whatever its endpoint; an unreadable file has no key to revoke.
    const replaced = yield* readConnection.pipe(Effect.orElseSucceed(() => undefined));
    const saved = override === undefined ? yield* readConnection : undefined;
    const endpoint = yield* resolveEndpoint(saved, override);
    let connection: Connection;
    let models: number;
    if (options.apiKey || options.keyStdin) {
      connection = { baseUrl: endpoint, apiKey: yield* readKey(options.keyStdin) };
      // The CLI didn't create a pasted key, so it never revokes one; the saved key pasted back stays its own.
      if (replaced?.createdKey && sameKey(replaced, connection))
        connection = { ...connection, createdKey: replaced.createdKey };
      models = yield* keep(connection);
    } else {
      [connection, models] = yield* deviceLogin(endpoint, options.noBrowser, (created) =>
        keep(created).pipe(Effect.map((count) => [created, count] as const)),
      );
    }
    const revoked =
      replaced?.createdKey && !sameKey(replaced, connection)
        ? yield* revokeOrWarn(replaced.baseUrl, replaced.apiKey, "The previous login's key still works.")
        : false;
    if (output.stdout.decorative) {
      yield* output.notice("success", "Signed in to Impact.");
      yield* output.rows([
        ["Endpoint", endpoint],
        ["Models", `${models} available`],
        ...(revoked ? [["Previous key", "revoked"] as const] : []),
      ]);
    } else {
      yield* output.line(
        `Signed in to ${endpoint}. ${models} models available.${revoked ? " Revoked the previous login's key." : ""}`,
      );
    }
  }),
).pipe(Command.withDescription("Sign in through your browser, or import an API key"));

export const logout = Command.make(
  "logout",
  {
    keepKey: Flag.Boolean("keep-key").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Keep the key this login created working"),
    ),
  },
  Effect.fn(function* ({ keepKey }) {
    const output = yield* Output;
    yield* output.start("Sign out");
    const saved = yield* readConnection.pipe(Effect.orElseSucceed(() => undefined));
    const created = saved?.createdKey === undefined ? undefined : saved;
    const revoked =
      created && !keepKey
        ? yield* revokeOrWarn(created.baseUrl, created.apiKey, "Impact could not revoke this login's key.")
        : false;
    yield* removeConnection;
    yield* output.notice(
      "success",
      revoked
        ? "Signed out and revoked this login's key."
        : created && keepKey
          ? `Removed the saved Impact login. Its key keeps working until you revoke it on ${apiKeysPage(created.baseUrl)}.`
          : created
            ? "Removed the saved Impact login."
            : "Removed the saved Impact login. Manage or revoke API keys in the web app.",
    );
  }),
).pipe(Command.withDescription("Sign out, revoking the key impact login created"));

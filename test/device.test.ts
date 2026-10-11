import { NodeServices } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Console, Effect, Fiber, Redacted, Schema, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { TestClock } from "effect/testing";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { version } from "../package.json";
import * as Http from "../src/api/Http.ts";
import { createDeviceClient, waitForDeviceToken } from "../src/auth/Device.ts";
import { command } from "../src/Command.ts";
import {
  ApiKey,
  CreatedApiKey,
  DEFAULT_FUNDING,
  DEFAULT_KEY_ROUTING,
  DEFAULT_KEY_TOOLS,
} from "../src/schemas/Billing.ts";
import { makeOutput, Output } from "../src/ui/Output.ts";
import { isolatedEnvironment } from "./support/Environment.ts";
import { catalog } from "./support/Impact.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function deviceServer(replies: { status: number; body: unknown }[]) {
  const polls: { at: number; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    expect(request.url).toBe("/api/auth/device/token");
    polls.push({ at: Date.now(), body: JSON.parse(body) });
    const result = replies.shift() ?? { status: 400, body: { error: "expired_token" } };
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { client: createDeviceClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), polls };
}

describe("Better Auth SDK device polling", () => {
  it("handles pending and slow_down responses and respects the increased polling interval", async () => {
    const { client, polls } = await deviceServer([
      { status: 400, body: { error: "authorization_pending", error_description: "Waiting" } },
      { status: 400, body: { error: "slow_down", error_description: "Wait longer" } },
      { status: 200, body: { access_token: "test-session", token_type: "Bearer", expires_in: 600 } },
    ]);
    const token = await Effect.runPromise(
      waitForDeviceToken(client, { device_code: "test-code", expires_in: 30, interval: 1 }),
    );
    expect(token).toBe("test-session");
    expect(polls).toHaveLength(3);
    expect(polls[0]!.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "test-code",
      client_id: "impact-cli",
    });
    expect(polls[2]!.at - polls[1]!.at).toBeGreaterThanOrEqual(5900);
  }, 15_000);
  it("ends immediately after the user denies the request", async () => {
    const { client, polls } = await deviceServer([
      { status: 400, body: { error: "access_denied", error_description: "No" } },
    ]);
    await expect(
      Effect.runPromise(waitForDeviceToken(client, { device_code: "test-code", expires_in: 10, interval: 1 })),
    ).rejects.toThrow("denied");
    expect(polls).toHaveLength(1);
  });
  it("stops polling an expired device code", async () => {
    const { client, polls } = await deviceServer([]);
    await expect(
      Effect.runPromise(waitForDeviceToken(client, { device_code: "test-code", expires_in: 0, interval: 1 })),
    ).rejects.toThrow("expired");
    expect(polls).toHaveLength(0);
  });
  effectIt.effect("expires during the polling delay without requesting a token", () =>
    Effect.gen(function* () {
      const { client, polls } = yield* Effect.promise(() =>
        deviceServer([{ status: 200, body: { access_token: "too-late" } }]),
      );
      const pending = yield* waitForDeviceToken(client, { device_code: "test-code", expires_in: 2, interval: 5 }).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(pending)).message).toContain("expired");
      expect(polls).toHaveLength(0);
    }),
  );
});

const environment = isolatedEnvironment();
const secretFor = (n: number) => `sk-imp-${String(n).padStart(43, "K")}`;
const pasted = `sk-imp-${"P".repeat(43)}`;
const encodeCreated = Schema.encodeSync(Schema.toCodecJson(CreatedApiKey));

const body = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += chunk.toString();
  return text;
};

interface ImpactOptions {
  /** HTTP status of the catalog check that follows key creation. */
  readonly models?: number;
  /** HTTP status of self-revocation for keys Impact still knows. */
  readonly revoke?: number;
}

/** Impact's device sign-in, key creation, catalog and self-revocation, recording what the CLI sent. */
async function impactServer(options: ImpactOptions = {}) {
  const state = {
    created: [] as { id: string; secret: string; name: string; monthlyLimitMicros: unknown }[],
    revoked: [] as string[],
    revokeAttempts: [] as string[],
    tokenPolls: 0,
    signOuts: 0,
    userAgents: new Map<string, string | undefined>(),
  };
  const server = createServer(async (request, response) => {
    // The RPC client posts to `/rpc/`.
    const path = new URL(request.url ?? "/", "http://x").pathname.replace(/(.)\/$/, "$1");
    state.userAgents.set(path, request.headers["user-agent"]);
    const text = await body(request);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    switch (path) {
      case "/api/auth/device/code":
        return json(200, {
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: `${base}/device`,
          verification_uri_complete: `${base}/device?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        });
      case "/api/auth/device/token":
        state.tokenPolls += 1;
        return json(200, { access_token: "device-session", token_type: "Bearer", expires_in: 600 });
      case "/api/auth/sign-out":
        state.signOuts += 1;
        return json(200, { success: true });
      case "/rpc": {
        const lines = text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const replies = lines
          .filter((message) => message._tag === "Request" && message.tag === "ApiKeysCreate")
          .map((message) => {
            const n = state.created.length + 1;
            const key = { id: `key_${n}`, secret: secretFor(n), ...message.payload };
            state.created.push(key);
            const created = new CreatedApiKey({
              key: new ApiKey({
                id: key.id,
                name: key.name,
                suffix: key.secret.slice(-4),
                canCopy: true,
                monthlyLimitMicros: null,
                funding: [...DEFAULT_FUNDING],
                tools: DEFAULT_KEY_TOOLS,
                routing: DEFAULT_KEY_ROUTING,
                createdAt: 0,
                lastUsedAt: null,
                requests30d: 0,
                charged30dMicros: 0,
                chargedThisMonthMicros: 0,
              }),
              secret: Redacted.make(key.secret),
            });
            return JSON.stringify({
              _tag: "Exit",
              requestId: message.id,
              exit: { _tag: "Success", value: encodeCreated(created) },
            });
          });
        response.writeHead(200, { "content-type": "application/ndjson" });
        return response.end(replies.map((line) => `${line}\n`).join(""));
      }
      case "/v1/models":
        return json(options.models ?? 200, catalog);
      case "/v1/keys/self/revoke": {
        state.revokeAttempts.push(bearer);
        const known =
          (state.created.some((key) => key.secret === bearer) || bearer === pasted) && !state.revoked.includes(bearer);
        if (!known) return json(401, { error: { message: "Invalid API key" } });
        if ((options.revoke ?? 204) !== 204) return json(options.revoke!, { error: { message: "Unavailable" } });
        state.revoked.push(bearer);
        response.writeHead(204).end();
        return;
      }
      default:
        return json(404, {});
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state };
}

const plain = { decorative: false, color: 0, unicode: false, width: 80 } as const;

/** Runs the real `impact` command, reading `stdin` when given; returns what it printed. */
const impact = (args: string[], stdin?: string) =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const capture: Console.Console = Object.assign(Object.create(console), {
      log: (...parts: unknown[]) => lines.push(parts.join(" ")),
    });
    const run = Command.runWith(command, { version })(args);
    const input = new TextEncoder().encode(stdin);
    const exit = yield* (
      stdin === undefined
        ? run
        : run.pipe(Effect.updateService(Stdio.Stdio, (stdio) => ({ ...stdio, stdin: Stream.make(input) })))
    ).pipe(
      Effect.provide([NodeServices.layer, Http.layer]),
      Effect.provideService(Output, makeOutput(plain, plain)),
      Effect.provideService(Console.Console, capture),
      Effect.exit,
    );
    return { exit, output: lines.join("\n") };
  });

/**
 * `impact login` through the browser on the test clock. Impact's device code asks for the first
 * poll after a second: the clock moves until Impact sees that poll, and the login finishes on its own.
 */
const deviceLogin = (impactState: { readonly tokenPolls: number }, base: string) =>
  Effect.gen(function* () {
    const polls = impactState.tokenPolls;
    const login = yield* impact(["login", "--no-browser", "--base-url", base]).pipe(Effect.forkChild);
    while (impactState.tokenPolls === polls && login.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 second");
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return yield* Fiber.join(login);
  });

const credentials = () => join(environment.directory, "credentials.json");
const saved = () => Effect.promise(async () => JSON.parse(await readFile(credentials(), "utf8")));

describe("impact login and logout", () => {
  effectIt.effect("creates an uncapped key, saves its id and names the CLI release on every call", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      const login = yield* deviceLogin(state, base);
      expect(login.exit._tag).toBe("Success");
      expect(state.created).toMatchObject([{ id: "key_1", monthlyLimitMicros: null }]);
      expect(yield* saved()).toEqual({ baseUrl: base, apiKey: secretFor(1), createdKey: { id: "key_1" } });
      expect(state.signOuts).toBe(1);
      expect(state.revokeAttempts).toEqual([]);
      for (const path of [
        "/api/auth/device/code",
        "/api/auth/device/token",
        "/rpc",
        "/api/auth/sign-out",
        "/v1/models",
      ])
        expect(state.userAgents.get(path), path).toBe(Http.USER_AGENT);
      expect(Http.USER_AGENT).toBe(`impact-cli/${version} (${process.platform}; ${process.arch})`);
    }),
  );

  effectIt.effect("revokes the key of the login it replaces once the new key is saved", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* deviceLogin(state, base);
      const again = yield* deviceLogin(state, base);
      expect(again.exit._tag).toBe("Success");
      expect(state.revoked).toEqual([secretFor(1)]);
      expect(yield* saved()).toEqual({ baseUrl: base, apiKey: secretFor(2), createdKey: { id: "key_2" } });
      expect(again.output).toContain("Revoked the previous login's key.");
    }),
  );

  effectIt.effect("revokes the new key when the login fails after creating it", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer({ models: 503 }));
      const login = yield* deviceLogin(state, base);
      expect(login.exit._tag).toBe("Failure");
      expect(state.revoked).toEqual([secretFor(1)]);
      expect(state.signOuts).toBe(1);
      yield* Effect.promise(() => expect(readFile(credentials(), "utf8")).rejects.toMatchObject({ code: "ENOENT" }));
    }),
  );

  effectIt.effect("logout revokes the login's key, and --keep-key keeps it", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* deviceLogin(state, base);
      const logout = yield* impact(["logout"]);
      expect(logout.exit._tag).toBe("Success");
      expect(logout.output).toBe("Signed out and revoked this login's key.");
      expect(state.revoked).toEqual([secretFor(1)]);
      yield* Effect.promise(() => expect(readFile(credentials(), "utf8")).rejects.toMatchObject({ code: "ENOENT" }));

      yield* deviceLogin(state, base);
      const kept = yield* impact(["logout", "--keep-key"]);
      expect(kept.output).toBe(
        `Removed the saved Impact login. Its key keeps working until you revoke it on ${base}/api-keys.`,
      );
      expect(state.revoked).toEqual([secretFor(1)]);
      expect(state.revokeAttempts).toEqual([secretFor(1)]);
    }),
  );

  effectIt.effect("never revokes a pasted key, even when a login replaces it", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* Effect.promise(() =>
        writeFile(credentials(), JSON.stringify({ baseUrl: base, apiKey: pasted }), { mode: 0o600 }),
      );
      const logout = yield* impact(["logout"]);
      expect(logout.output).toBe("Removed the saved Impact login. Manage or revoke API keys in the web app.");
      yield* Effect.promise(() =>
        writeFile(credentials(), JSON.stringify({ baseUrl: base, apiKey: pasted }), { mode: 0o600 }),
      );
      yield* deviceLogin(state, base);
      expect(state.revokeAttempts).toEqual([]);
      expect((yield* saved()).createdKey).toEqual({ id: "key_1" });
    }),
  );

  effectIt.effect("revokes the browser login's key when a pasted key replaces it", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* deviceLogin(state, base);
      const login = yield* impact(["login", "--key-stdin", "--base-url", base], pasted);
      expect(login.exit._tag).toBe("Success");
      expect(state.revokeAttempts).toEqual([secretFor(1)]);
      expect(yield* saved()).toEqual({ baseUrl: base, apiKey: pasted });
      expect(login.output).toContain("Revoked the previous login's key.");
    }),
  );

  effectIt.effect("keeps the browser login's key as its own when it is pasted back", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* deviceLogin(state, base);
      const login = yield* impact(["login", "--key-stdin", "--base-url", base], secretFor(1));
      expect(login.exit._tag).toBe("Success");
      expect(state.revokeAttempts).toEqual([]);
      expect(yield* saved()).toEqual({ baseUrl: base, apiKey: secretFor(1), createdKey: { id: "key_1" } });
    }),
  );

  effectIt.effect("treats a key Impact no longer accepts as revoked", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer());
      yield* deviceLogin(state, base);
      state.revoked.push(secretFor(1));
      const logout = yield* impact(["logout"]);
      expect(logout.exit._tag).toBe("Success");
      expect(logout.output).toBe("Signed out and revoked this login's key.");
      expect(state.revokeAttempts).toEqual([secretFor(1)]);
    }),
  );

  effectIt.effect("warns with the API keys page when revocation fails, and still signs out", () =>
    Effect.gen(function* () {
      const { base, state } = yield* Effect.promise(() => impactServer({ revoke: 503 }));
      yield* deviceLogin(state, base);
      const logout = yield* impact(["logout"]);
      expect(logout.exit._tag).toBe("Success");
      expect(logout.output).toBe(
        `Impact could not revoke this login's key. Revoke it on ${base}/api-keys.\nRemoved the saved Impact login.`,
      );
      expect(state.revoked).toEqual([]);
      yield* Effect.promise(() => expect(readFile(credentials(), "utf8")).rejects.toMatchObject({ code: "ENOENT" }));
    }),
  );
});

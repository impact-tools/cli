import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceClient, waitForDeviceToken } from "../src/auth/Device.ts";

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

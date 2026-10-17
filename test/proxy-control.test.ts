import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemonEnvironment, SHUTDOWN_PATH, STATUS_PATH, stopProxy } from "../src/proxy/Control.ts";
import type { ProxySetup } from "../src/proxy/State.ts";

const identity = (pid = process.pid + 1) => ({
  pid,
  version: "legacy-daemon",
  startedAt: "2026-10-09T00:00:00.000Z",
  port: 0,
  login: "legacy-login",
});

const setupFor = (port: number) =>
  ({
    config: {
      version: 1,
      port,
      username: "legacy-user",
      password: "legacy-password",
      sessionKey: "legacy-session",
      createdAt: "2026-10-09T00:00:00.000Z",
    },
  }) as ProxySetup;

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const runServer = async (statuses: Array<ReturnType<typeof identity> | undefined>, shutdownStatus: number) => {
  const server = createServer((request, response) => {
    if (request.url === STATUS_PATH) {
      const body = statuses.shift();
      if (body) {
        json(response, 200, { ...body, port: (server.address() as AddressInfo).port });
      } else {
        json(response, 404, { error: "not running" });
      }
      return;
    }
    if (request.url === SHUTDOWN_PATH) {
      json(response, shutdownStatus, shutdownStatus === 202 ? {} : { error: "unsupported" });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, setup: setupFor((server.address() as AddressInfo).port) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("does not pass invocation credentials into the background daemon", () => {
  const source = {
    PATH: "/bin",
    IMPACT_API_KEY: "old-key",
    IMPACT_BASE_URL: "https://old.example",
    IMPACT_LAUNCH_CWD: "/tmp/workspace",
    IMPACT_CURSOR_BIN: "/Applications/Cursor.app",
  };
  expect(daemonEnvironment(source)).toEqual({
    PATH: "/bin",
    IMPACT_CURSOR_BIN: "/Applications/Cursor.app",
  });
  expect(daemonEnvironment(source, false)).toMatchObject({
    IMPACT_API_KEY: "old-key",
    IMPACT_BASE_URL: "https://old.example",
  });
  expect(source).toEqual({
    PATH: "/bin",
    IMPACT_API_KEY: "old-key",
    IMPACT_BASE_URL: "https://old.example",
    IMPACT_LAUNCH_CWD: "/tmp/workspace",
    IMPACT_CURSOR_BIN: "/Applications/Cursor.app",
  });
});

describe("legacy proxy shutdown", () => {
  it("signals a matching legacy daemon after authenticated 404", async () => {
    const { server, setup } = await runServer([identity(), identity()], 404);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(Effect.runPromise(stopProxy(setup))).resolves.toBeDefined();
      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it.each([401, 403, 500, 503])("does not signal when legacy shutdown returns %s", async (shutdownStatus) => {
    const { server, setup } = await runServer([identity()], shutdownStatus);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(Effect.runPromise(stopProxy(setup))).rejects.toMatchObject({
        message: "Cannot stop the Impact proxy.",
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("does not signal when the authenticated status identity changes", async () => {
    const { server, setup } = await runServer([identity(), identity(process.pid + 2)], 404);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(Effect.runPromise(stopProxy(setup))).rejects.toMatchObject({
        message: "Cannot stop the Impact proxy.",
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("does not signal when the initial authenticated status is unavailable", async () => {
    const { server, setup } = await runServer([], 404);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(Effect.runPromise(stopProxy(setup))).resolves.toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});


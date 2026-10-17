import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

import { createProxySetup } from "../src/proxy/State.ts";
import { isolatedEnvironment } from "./support/Environment.ts";

isolatedEnvironment();

it("replaces an existing setup when generated files are written again", async () => {
  const first = await Effect.runPromise(createProxySetup());
  const original = await readFile(first.paths.config, "utf8");
  const second = await Effect.runPromise(createProxySetup());
  expect(second.paths.config).toBe(first.paths.config);
  expect(await readFile(second.paths.config, "utf8")).not.toBe(original);
});

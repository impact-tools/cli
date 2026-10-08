import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { expect, it, vi } from "vitest";

import * as Http from "../src/api/Http.ts";
import { checkForUpdate, isNewerRelease } from "../src/api/Update.ts";

it.each([
  ["0.1.0", "0.1.1", true],
  ["0.1.1", "0.2.0", true],
  ["0.1.1", "0.1.1", false],
  ["0.2.0", "0.1.9", false],
  ["0.1.0", "0.2.0-beta.1", false],
  ["dev", "0.2.0", false],
] as const)(
  "compares published versions independently of npm response shape (%s → %s)",
  (current, latest, expected) => {
    expect(isNewerRelease(current, latest)).toBe(expected);
  },
);

it("reads a newer npm release and ignores malformed or failed responses", async () => {
  const fetch = vi.fn(async (input: string | Request | URL) => {
    const url = String(input);
    if (url.endsWith("/new")) return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
    if (url.endsWith("/malformed")) return new Response(JSON.stringify({ version: "latest" }), { status: 200 });
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetch as unknown as typeof globalThis.fetch);
  vi.stubEnv("IMPACT_UPDATE_REGISTRY_URL", "https://registry.test/new");
  try {
    const update = await Effect.runPromise(
      checkForUpdate("0.1.0").pipe(Effect.provide([NodeServices.layer, Http.layer])),
    );
    expect(Option.isSome(update)).toBe(true);
    if (Option.isSome(update)) expect(update.value).toEqual({ current: "0.1.0", latest: "0.2.0" });
    vi.stubEnv("IMPACT_UPDATE_REGISTRY_URL", "https://registry.test/malformed");
    expect(
      Option.isNone(
        await Effect.runPromise(checkForUpdate("0.1.0").pipe(Effect.provide([NodeServices.layer, Http.layer]))),
      ),
    ).toBe(true);
    vi.stubEnv("IMPACT_UPDATE_REGISTRY_URL", "https://registry.test/down");
    expect(
      Option.isNone(
        await Effect.runPromise(checkForUpdate("0.1.0").pipe(Effect.provide([NodeServices.layer, Http.layer]))),
      ),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

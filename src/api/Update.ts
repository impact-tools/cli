import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const PACKAGE_NAME = "@impact-relay/cli";
const REGISTRY_URL = "https://registry.npmjs.org/@impact-relay%2fcli/latest";

const RegistryRelease = Schema.Struct({ version: Schema.String });
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type ParsedVersion = readonly [major: number, minor: number, patch: number, prerelease: string | undefined];

const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = versionPattern.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
};

/** Returns true only when the registry version is a newer stable release. */
export const isNewerRelease = (current: string, latest: string): boolean => {
  const left = parseVersion(current);
  const right = parseVersion(latest);
  if (!left || !right || right[3] !== undefined) return false;
  for (const index of [0, 1, 2] as const) {
    if (right[index] !== left[index]) return right[index] > left[index];
  }
  return false;
};

/** A best-effort npm check; update discovery must never prevent a CLI command from starting. */
export const checkForUpdate = Effect.fnUntraced(
  function* (current: string) {
    const url = process.env.IMPACT_UPDATE_REGISTRY_URL ?? REGISTRY_URL;
    const response = yield* HttpClientRequest.get(url, {
      headers: { accept: "application/json", "user-agent": `${PACKAGE_NAME}/${current}` },
    }).pipe(HttpClient.execute);
    if (response.status !== 200) return yield* Effect.succeedNone;
    const release = yield* HttpClientResponse.schemaBodyJson(RegistryRelease)(response).pipe(Effect.option);
    if (Option.isNone(release) || !isNewerRelease(current, release.value.version)) return yield* Effect.succeedNone;
    return Option.some({ current, latest: release.value.version });
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("700 millis"),
      Effect.catch(() => Effect.succeedNone),
    ),
);

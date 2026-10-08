import { DateTime, Effect, FileSystem } from "effect";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

import type { Usage } from "../../api/Usage.ts";

import { CliError, mapPlatformError } from "../../Errors.ts";
import { codexHome } from "./Config.ts";

/** Local identity for Codex's account UI; the proxy alone holds the actual Impact credential. */
export const impactCodexAuth = Effect.fn("impactCodexAuth")(function* (usage: Usage) {
  if (!usage.account)
    return yield* new CliError({
      message: "Impact did not return the key's account. Update the Impact server before launching Codex.",
    });
  const fs = yield* FileSystem.FileSystem;
  const source = codexHome();
  yield* fs.makeDirectory(source, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectoryScoped({ directory: source, prefix: ".impact-" });
  for (const name of ["sessions", "archived_sessions", "skills", "plugins", "memories", "shell_snapshots", "log"]) {
    yield* fs.makeDirectory(join(source, name), { recursive: true });
    yield* fs.symlink(join(source, name), join(directory, name));
  }
  for (const name of ["config.toml", "AGENTS.md", "history.jsonl"]) {
    if (name === "history.jsonl") yield* fs.writeFileString(join(source, name), "", { flag: "a", mode: 0o600 });
    if (yield* fs.exists(join(source, name))) yield* fs.symlink(join(source, name), join(directory, name));
  }
  const now = yield* DateTime.now;
  const claims = {
    iss: "impact-local",
    sub: usage.account.id,
    email: `Impact · ${usage.account.email}`,
    iat: Math.floor(DateTime.toEpochMillis(now) / 1000),
    "https://api.openai.com/auth": {
      chatgpt_user_id: usage.account.id,
      chatgpt_plan_type: "unknown",
    },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const token = `${payload}.${createHmac("sha256", randomBytes(32)).update(payload).digest("base64url")}`;
  yield* fs.writeFileString(
    join(directory, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgptAuthTokens",
      OPENAI_API_KEY: null,
      // Impact has no ChatGPT workspace. A workspace ID makes Codex discard the account email on routing updates.
      tokens: { id_token: token, access_token: token, refresh_token: "", account_id: null },
      last_refresh: DateTime.formatIso(now),
    }),
    { mode: 0o600 },
  );
  return { directory, accountId: usage.account.id };
}, mapPlatformError("Cannot prepare the Codex home"));

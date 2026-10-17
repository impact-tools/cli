import { Redacted } from "effect";
import { existsSync } from "node:fs";
import which from "which";

import type { Connection } from "../config/Connection.ts";

export interface LaunchOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly connection: Connection;
}

export const executableVariable = (name: string) => `IMPACT_${name.toUpperCase()}_BIN`;

export const findExecutable = (name: string): string | null => {
  const desktop = name === "cursor"
    ? "/Applications/Cursor.app/Contents/MacOS/Cursor"
    : name === "antigravity"
      ? ["/Applications/Antigravity IDE.app/Contents/MacOS/Electron", "/Applications/Antigravity.app/Contents/MacOS/Antigravity"].find(path => existsSync(path))
      : undefined;
  const fallback = desktop && process.platform === "darwin" && existsSync(desktop) ? desktop : name;
  return which.sync(process.env[executableVariable(name)] ?? fallback, { nothrow: true });
};

export const clientEnvironment = (connection: Connection): NodeJS.ProcessEnv => ({
  ...process.env,
  IMPACT_API_KEY: Redacted.value(connection.apiKey),
  IMPACT_BASE_URL: connection.baseUrl,
});

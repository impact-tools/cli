import { Redacted } from "effect";
import which from "which";

import type { Connection } from "../config/Connection.ts";

export interface LaunchOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly connection: Connection;
}

export const executableVariable = (name: string) => `IMPACT_${name.toUpperCase()}_BIN`;

export const findExecutable = (name: string): string | null =>
  which.sync(process.env[executableVariable(name)] ?? name, { nothrow: true });

export const clientEnvironment = (connection: Connection): NodeJS.ProcessEnv => ({
  ...process.env,
  IMPACT_API_KEY: Redacted.value(connection.apiKey),
  IMPACT_BASE_URL: connection.baseUrl,
});

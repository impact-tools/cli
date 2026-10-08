import { resolve } from "node:path";

/** The argv prefix that re-runs this CLI, for both the JavaScript bundle and a compiled executable. */
export function selfCommand(): string[] {
  const entry = process.argv[1];
  const compiled = entry?.startsWith("/$bunfs/") || entry?.includes(":/~BUN/");
  return compiled || entry === process.execPath
    ? [process.execPath]
    : [process.execPath, ...(process.versions.bun ? ["--no-env-file"] : []), resolve(entry!)];
}

export const shellQuote = (value: string) =>
  process.platform === "win32" ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;

/** A shell command line that runs `impact helper <args>`, for client settings that take a command. */
export const helperCommand = (...args: string[]) => [...selfCommand(), "helper", ...args].map(shellQuote).join(" ");

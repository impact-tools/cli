/** Where a setup runs: a POSIX shell on macOS and Linux, PowerShell on Windows. */
export type Platform = "unix" | "windows";

export const PLATFORMS = ["unix", "windows"] as const satisfies readonly Platform[];

export const shellLanguage = (platform: Platform) => (platform === "windows" ? "powershell" : "bash");

/** `value` in double quotes, with what the shell would expand there escaped. */
export const quote = (platform: Platform, value: string) =>
  platform === "windows" ? `"${value.replace(/[`"$]/g, "`$&")}"` : `"${value.replace(/[\\"$`]/g, "\\$&")}"`;

/** Lines that set `variables` for the rest of this terminal session. */
export const exportLines = (platform: Platform, variables: Readonly<Record<string, string>>) =>
  Object.entries(variables).map(([name, value]) =>
    platform === "windows" ? `$env:${name} = ${quote(platform, value)}` : `export ${name}=${quote(platform, value)}`,
  );

/** A file under the home folder, as the platform writes its path. */
export const homeFile = (platform: Platform, ...segments: readonly string[]) =>
  platform === "windows" ? `%USERPROFILE%\\${segments.join("\\")}` : `~/${segments.join("/")}`;

/** One command over several lines. */
export const continued = (platform: Platform, parts: readonly string[]) =>
  parts.join(platform === "windows" ? " `\n  " : " \\\n  ");

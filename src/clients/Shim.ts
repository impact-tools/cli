import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export interface Command {
  readonly executable: string;
  readonly args: readonly string[];
}

/** What npm writes into a `.cmd` shim: `"%_prog%" "%dp0%\path\to\script" %*`. */
const SHIM_TARGET = /"(?:%_prog%|%dp0%\\node\.exe|node)"\s+"%dp0%\\([^"]+)"\s+%\*/i;
const SHIM_NATIVE = /"%dp0%\\([^"]+\.exe)"\s+%\*/i;

/**
 * Node refuses to spawn a `.cmd`/`.bat` file without a shell (`spawn EINVAL`, CVE-2024-27980), and a shell
 * would re-parse the arguments. A Windows npm shim is therefore replaced by what it runs: the native
 * `.exe`, or `node <script>`. Anything else (or another platform) is returned as it is.
 */
export const resolveCommand = (
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Command => {
  const extension = extname(executable).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) return { executable, args };
  try {
    const text = read(executable);
    const base = dirname(executable);
    const native = SHIM_NATIVE.exec(text)?.[1];
    if (native) return { executable: resolve(base, native), args };
    const script = SHIM_TARGET.exec(text)?.[1];
    if (script) return { executable: process.execPath, args: [resolve(base, script), ...args] };
  } catch {
    // An unreadable shim is started as it is; the spawn error then names it.
  }
  return { executable, args };
};

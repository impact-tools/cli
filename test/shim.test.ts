import { describe, expect, it } from "vitest";

import { resolveCommand } from "../src/clients/Shim.ts";

const npmShim = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*
`;

describe("resolveCommand", () => {
  it("replaces an npm shim with node and its script on Windows", () => {
    const command = resolveCommand("C:\\npm\\opencode.cmd", ["--help"], "win32", () => npmShim);
    expect(command.executable).toBe(process.execPath);
    expect(command.args.at(-1)).toBe("--help");
    expect(command.args[0]).toContain("opencode-ai");
  });

  it("leaves other files and platforms alone", () => {
    expect(resolveCommand("C:\\bin\\opencode.exe", ["a"], "win32")).toEqual({
      executable: "C:\\bin\\opencode.exe",
      args: ["a"],
    });
    expect(resolveCommand("/bin/opencode.cmd", ["a"], "linux")).toEqual({
      executable: "/bin/opencode.cmd",
      args: ["a"],
    });
  });

  it("keeps an unreadable or unknown shim as it is", () => {
    expect(resolveCommand("C:\\x.cmd", [], "win32", () => "echo hi").executable).toBe("C:\\x.cmd");
    expect(
      resolveCommand("C:\\x.cmd", [], "win32", () => {
        throw new Error("nope");
      }).executable,
    ).toBe("C:\\x.cmd");
  });
});

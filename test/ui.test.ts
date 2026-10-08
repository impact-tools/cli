import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { command } from "../src/Command.ts";
import { heading, rows, width, wrap } from "../src/ui/Layout.ts";
import { logo } from "../src/ui/Logo.ts";
import { makeOutput, Output } from "../src/ui/Output.ts";
import { withProgress } from "../src/ui/Progress.ts";
import { capabilities, clean, paint, promptTheme, type Capabilities } from "../src/ui/Theme.ts";
import { welcome } from "../src/ui/Welcome.ts";

const tty: Capabilities = { decorative: true, color: 24, unicode: true, width: 80 };
const plain: Capabilities = { decorative: false, color: 0, unicode: false, width: 80 };

describe("terminal presentation", () => {
  it("detects each stream independently and honors plain-output controls", () => {
    const stream = { isTTY: true, columns: 40, getColorDepth: () => 24 };
    expect(capabilities(stream, {})).toEqual({ ...tty, width: 40 });
    for (const env of [{ TERM: "dumb" }, { CI: "true" }]) {
      expect(capabilities(stream, env)).toMatchObject({ decorative: false, color: 0, unicode: false });
    }
    for (const env of [{ NO_COLOR: "" }, { NO_COLOR: "1", FORCE_COLOR: "3" }, { FORCE_COLOR: "0" }]) {
      expect(capabilities(stream, env)).toMatchObject({ decorative: true, color: 0, unicode: true });
    }
    expect(capabilities({ isTTY: false }, { FORCE_COLOR: "3" })).toEqual(plain);
    expect(capabilities(stream, { LANG: "C" }).unicode).toBe(false);
    expect(capabilities(stream, { FORCE_COLOR: "1" }).color).toBe(4);
    expect(capabilities(stream, { FORCE_COLOR: "2" }).color).toBe(8);
    expect(capabilities({ isTTY: true, getColorDepth: () => 1 }, {}).color).toBe(0);
  });

  it("uses semantic colors with explicit resets and no escapes in monochrome", () => {
    expect(paint(tty, "primary", "Impact")).toBe("\x1b[38;2;202;170;235mImpact\x1b[0m");
    expect(paint({ ...tty, color: 8 }, "primary", "Impact")).toContain("38;5;183");
    expect(paint({ ...tty, color: 4 }, "primary", "Impact")).toContain("[35m");
    expect(paint(plain, "primary", "Impact")).toBe("Impact");
    expect(promptTheme(plain).primaryColor).toBe("");
    expect(promptTheme(tty).passwordMask).toBe("*");
  });

  it("escapes untrusted terminal controls before styling", () => {
    const text = clean("name\x1b[2J\r\x07\u009b31m‮");
    expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f‮]/);
    expect(text).toContain("\\u001b[2J");
    expect(rows(tty, [["Account", "name\x1b[2J"]])).toContain("\\u001b[2J");
  });

  it("measures terminal cells and preserves copyable URLs and paths", () => {
    expect(width("é界")).toBe(3);
    expect(width("👩‍💻")).toBe(2);
    expect(width(paint(tty, "primary", "界"))).toBe(2);
    expect(wrap("界界 é hello", 6)).toEqual(["界界 é", "hello"]);
    const url = `https://example.test/device?code=${"a".repeat(100)}`;
    const path = `/a path/${"directory/".repeat(10)}client`;
    const result = rows({ ...tty, width: 40 }, [
      ["Verify", url],
      ["Client", path],
    ]);
    expect(result).toContain(`\n  ${url}`);
    expect(result).toContain(`\n  ${path}`);
    expect(
      heading({ ...tty, width: 40 }, "CONNECTION")
        .split("\n")
        .every((line) => width(line) <= 40),
    ).toBe(true);
  });

  it("renders deterministic wide and compact logos, and no redirected banner", () => {
    expect(logo(plain)).toBe("");
    const wide = logo({ ...tty, color: 0 });
    expect(wide).toMatchSnapshot();
    expect(wide).toContain("███");
    expect(wide).not.toContain("coding clients, connected.");
    expect(wide).not.toContain("\x1b");
    expect(wide.split("\n").every((line) => width(line) <= 72)).toBe(true);
    expect(logo({ ...tty, width: 40, color: 0 })).toBe("\n  ✦ ˖  Impact LLM\n");
    const ascii = logo({ ...tty, unicode: false, color: 0 });
    expect(ascii).toMatchSnapshot();
    expect(ascii).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("owns the banner per invocation, with error styling on stderr only", () => {
    const first = makeOutput(tty, plain);
    expect(first.banner(true)).toContain("███");
    expect(first.banner()).toBe("");
    expect(first.error("No key.")).toBe("No key.");
    expect(makeOutput(tty, tty).banner()).toContain("Impact LLM");
    const mixed = makeOutput(plain, tty);
    expect(mixed.banner()).toBe("");
    expect(mixed.error("No key.")).toContain("\x1b");
    expect(mixed.error("No key.")).not.toContain("Impact LLM");
  });
});

describe("landing states", () => {
  it("shows a framed sign-in requirement instead of connected actions", () => {
    for (const columns of [80, 40, 24]) {
      const caps = { ...tty, width: columns };
      const rendered = welcome(command, makeOutput(caps, caps), { state: "guest" });
      const text = stripVTControlCharacters(rendered);
      expect(text).toContain("Sign in to continue");
      expect(text).toContain("impact login");
      for (const name of ["claude", "codex", "kilo", "opencode", "status", "doctor", "logout"]) {
        expect(text).not.toContain(`impact ${name}`);
      }
      expect(text).not.toContain("Start a client");
      expect(text).not.toContain("coding clients, connected.");
    }
    const narrow = stripVTControlCharacters(
      welcome(command, makeOutput({ ...tty, width: 40 }, plain), { state: "guest" }),
    );
    expect(narrow.split("\n").every((line) => width(line) <= 40)).toBe(true);
  });

  it("places actual account summary above compact connected actions", () => {
    const rendered = welcome(command, makeOutput(tty, tty), {
      state: "connected",
      summary: "Impact · demo@example.test · $14.845 USD",
    });
    const text = stripVTControlCharacters(rendered);
    expect(text.indexOf("demo@example.test")).toBeLessThan(text.indexOf("Start a client"));
    expect(text).toContain("$14.845 USD");
    expect(text).toContain("impact claude");
    expect(text).toContain("impact doctor");
    expect(text).not.toContain("impact login");
    expect(text).not.toContain("all arguments go to the client");
    expect(text).not.toContain("--completions");
    expect(text).not.toContain("helper");
  });
});

describe("scoped progress", () => {
  it("clears the active line on success and failure", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      for (const task of [Effect.succeed("ok"), Effect.fail("denied")]) {
        write.mockClear();
        await Effect.runPromiseExit(
          withProgress("Waiting for approval…", task).pipe(Effect.provideService(Output, makeOutput(tty, tty))),
        );
        expect(write.mock.calls[0]?.[0]).toContain("Waiting for approval…");
        expect(write.mock.calls.at(-1)?.[0]).toBe("\r\x1b[2K");
      }
    } finally {
      write.mockRestore();
    }
  });

  effectIt.effect("stops animating and clears the line when interrupted without hiding the cursor", () =>
    Effect.gen(function* () {
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        const fiber = yield* withProgress("Waiting for approval…", Effect.never).pipe(
          Effect.provideService(Output, makeOutput(tty, tty)),
          Effect.forkChild,
        );
        yield* TestClock.adjust("120 millis");
        expect(write.mock.calls).toHaveLength(2);
        yield* Fiber.interrupt(fiber);
        expect(write.mock.calls.at(-1)?.[0]).toBe("\r\x1b[2K");
        yield* TestClock.adjust("1 second");
        expect(write.mock.calls).toHaveLength(3);
        expect(write.mock.calls.map(([text]) => text).join("")).not.toContain("?25l");
      } finally {
        write.mockRestore();
      }
    }),
  );
});

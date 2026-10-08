import { Console, Context, Effect } from "effect";

import type { UsageSpend } from "../schemas/Spend.ts";

import * as Layout from "./Layout.ts";
import { logo } from "./Logo.ts";
import { renderSpend } from "./Spend.ts";
import { capabilities, clean, paint, type Tone } from "./Theme.ts";

export type Presentation = Readonly<ReturnType<typeof makeOutput>>;

export const makeOutput = (stdout = capabilities(process.stdout), stderr = capabilities(process.stderr)) => {
  let bannerShown = false;
  const banner = (full = false): string => {
    if (bannerShown || !stdout.decorative) return "";
    bannerShown = true;
    return logo(stdout, full);
  };
  return {
    stdout,
    stderr,
    banner,
    error: (message: string) =>
      stderr.decorative
        ? `\n  ${paint(stderr, "error", stderr.unicode ? "×" : "!")} ${clean(message)}\n`
        : clean(message),
    start: (title: string) =>
      Effect.suspend(() =>
        stdout.decorative ? Console.log(`${banner()}\n${Layout.heading(stdout, title)}\n`) : Effect.void,
      ),
    section: (title: string) => (stdout.decorative ? Console.log(`\n${Layout.heading(stdout, title)}\n`) : Effect.void),
    rows: (items: ReadonlyArray<readonly [string, string]>, plain?: string) =>
      Console.log(!stdout.decorative && plain !== undefined ? clean(plain) : Layout.rows(stdout, items)),
    notice: (tone: Tone, message: string) => {
      if (!stdout.decorative) return Console.log(clean(message));
      const symbol =
        tone === "success"
          ? stdout.unicode
            ? "✓"
            : "+"
          : tone === "warning" || tone === "error"
            ? "!"
            : stdout.unicode
              ? "›"
              : ">";
      return Console.log(`  ${paint(stdout, tone, symbol)} ${clean(message)}`);
    },
    line: (text: string) => Console.log(clean(text)),
    spend: (data: UsageSpend | undefined) => Console.log(`\n${renderSpend(stdout, data)}`),
  };
};

export const Output = Context.Reference<Presentation>("impact/cli/ui/Output", { defaultValue: makeOutput });

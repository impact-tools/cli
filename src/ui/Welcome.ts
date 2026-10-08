import type { Command } from "effect/cli/Command";

import type { Presentation } from "./Output.ts";

import { heading, rows, width, wrap } from "./Layout.ts";
import { clean, paint } from "./Theme.ts";

export type WelcomeAccount = { readonly state: "guest" } | { readonly state: "connected"; readonly summary: string };

const signIn = (output: Presentation): string => {
  const caps = output.stdout;
  const title = "Sign in to continue";
  const description = "Connect your Impact account to launch coding clients.";
  if (!caps.decorative) return `${title}\n${description}\n\n  impact login`;
  if (caps.width < 30)
    return `${heading(caps, title)}\n\n${wrap(description, caps.width).join("\n")}\n\n${paint(caps, "primary", "impact login")}`;
  const inner = Math.min(60, caps.width - 8);
  const line = caps.unicode ? "─" : "-";
  const vertical = paint(caps, "dim", caps.unicode ? "│" : "|");
  const edge = (left: string, right: string) => `  ${paint(caps, "dim", left + line.repeat(inner + 2) + right)}`;
  const content = (text: string, tone: "primary" | "foreground" | "muted" = "foreground") =>
    `  ${vertical} ${paint(caps, tone, text)}${" ".repeat(Math.max(0, inner - width(text)))} ${vertical}`;
  return [
    edge(caps.unicode ? "╭" : "+", caps.unicode ? "╮" : "+"),
    content(""),
    content(title),
    content(""),
    ...wrap(description, inner).map((text) => content(text, "muted")),
    content(""),
    content(`${caps.unicode ? "›" : ">"} impact login`, "primary"),
    content(""),
    edge(caps.unicode ? "╰" : "+", caps.unicode ? "╯" : "+"),
  ].join("\n");
};

export const welcome = (command: Command.Any, output: Presentation, account: WelcomeAccount): string => {
  const caps = output.stdout;
  const sections = [output.banner(true) || "Impact LLM"];
  if (account.state === "guest") {
    sections.push(signIn(output));
  } else {
    sections.push(caps.decorative ? `  ${paint(caps, "foreground", clean(account.summary))}` : clean(account.summary));
    for (const group of command.subcommands) {
      const visible = group.commands.filter((item) => !item.unlisted && item.name !== "login");
      if (!visible.length) continue;
      const entries = visible.map(
        (item) =>
          [
            `${command.name} ${item.name}`,
            wrap(item.shortDescription || item.description || "", Math.max(1, caps.width - 2)).join("\n"),
          ] as const,
      );
      sections.push(`${heading(caps, group.group ?? "Commands")}\n${rows(caps, entries, "primary")}`);
    }
  }
  const help = `Full reference: ${clean(command.name)} --help`;
  sections.push(caps.decorative ? `  ${paint(caps, "muted", help)}` : help);
  return `${sections.join("\n\n")}\n`;
};

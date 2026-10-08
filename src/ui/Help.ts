import { Option } from "effect";
import { CliOutput, type HelpDoc } from "effect/cli";

import type { Presentation } from "./Output.ts";

import { heading, rows, wrap } from "./Layout.ts";
import { clean, paint, type Capabilities, type Tone } from "./Theme.ts";

const paragraph = (caps: Capabilities, text: string, tone: Tone = "foreground"): string =>
  wrap(text, Math.max(1, caps.width - 2))
    .map((line) => `  ${paint(caps, tone, line)}`)
    .join("\n");

const annotation = (description: Option.Option<string>, required: boolean): string =>
  [Option.getOrElse(description, () => ""), required ? "(required)" : "(optional)"].filter(Boolean).join(" ");

const flagRows = (flags: ReadonlyArray<HelpDoc.FlagDoc>): ReadonlyArray<readonly [string, string]> =>
  flags.map((flag) => [
    `${[`--${flag.name}`, ...flag.aliases].join(", ")} ${flag.type}`,
    annotation(flag.description, flag.required),
  ]);

const proseRows = (caps: Capabilities, items: ReadonlyArray<readonly [string, string]>): string =>
  rows(
    caps,
    items.map(([label, description]) => [label, wrap(description, Math.max(1, caps.width - 2)).join("\n")]),
  );

const renderHelp = (doc: HelpDoc.HelpDoc, output: Presentation): string => {
  const caps = output.stdout;
  const sections: string[] = [];
  const section = (title: string, body: string): void => {
    sections.push(`${heading(caps, title)}\n${body}`);
  };

  // Effect generates usage from the command path, followed by [flags] or
  // <subcommand>. The public HelpDoc has no separate command-path field.
  const commandPath = clean(doc.usage)
    .split(/\s+(?=[<[])/u, 1)[0]!
    .trim();
  const banner = output.banner(commandPath.split(/\s+/u).length === 1);
  if (banner) sections.push(banner);

  if (doc.description) section("DESCRIPTION", paragraph(caps, doc.description));
  section("USAGE", paragraph(caps, doc.usage, "primary"));

  if (doc.args?.length) {
    section(
      "ARGUMENTS",
      proseRows(
        caps,
        doc.args.map((arg) => [
          `${arg.name}${arg.variadic ? "..." : ""} ${arg.type}`,
          annotation(arg.description, arg.required),
        ]),
      ),
    );
  }

  if (doc.flags.length) section("FLAGS", proseRows(caps, flagRows(doc.flags)));
  if (doc.globalFlags?.length) section("GLOBAL FLAGS", proseRows(caps, flagRows(doc.globalFlags)));

  for (const group of doc.subcommands ?? []) {
    section(
      group.group ?? "SUBCOMMANDS",
      proseRows(
        caps,
        group.commands.map((command) => [
          [command.name, command.alias].filter((value) => value !== undefined).join(", "),
          command.shortDescription && command.shortDescription !== command.description
            ? [command.shortDescription, command.description].filter(Boolean).join("\n")
            : command.description || command.shortDescription || "",
        ]),
      ),
    );
  }

  if (doc.examples?.length) {
    section(
      "EXAMPLES",
      doc.examples
        .map((example) =>
          [
            example.description ? paragraph(caps, `# ${example.description}`, "muted") : "",
            `  ${paint(caps, "primary", clean(example.command))}`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    );
  }

  return sections.join("\n\n");
};

/** Public Effect formatter; the presentation owns invocation-scoped banner state. */
export const makeFormatter = (output: Presentation): CliOutput.Formatter => {
  const plain = CliOutput.defaultFormatter({ colors: false });
  const error = (text: string): string => {
    const safe = clean(text);
    return safe && output.stderr.decorative ? paint(output.stderr, "error", safe) : safe;
  };

  return {
    formatHelpDoc: (doc) => (output.stdout.decorative ? renderHelp(doc, output) : clean(plain.formatHelpDoc(doc))),
    formatCliError: (value) => error(plain.formatCliError(value)),
    formatError: (value) => error(plain.formatError(value)),
    formatErrors: (values) => error(plain.formatErrors(values)),
    formatVersion: (name, version) => clean(plain.formatVersion(name, version)),
  };
};

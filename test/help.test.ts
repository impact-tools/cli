import { Context, Option } from "effect";
import { CliError, CliOutput, type HelpDoc } from "effect/cli";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { makeFormatter } from "../src/ui/Help.ts";
import { makeOutput, type Presentation } from "../src/ui/Output.ts";
import { clean, type Capabilities } from "../src/ui/Theme.ts";

const capabilities = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  decorative: true,
  color: 0,
  unicode: false,
  width: 100,
  ...overrides,
});

const presentation = (stdout: Capabilities = capabilities(), stderr: Capabilities = stdout) => {
  let shown = false;
  const banner = vi.fn((full = false): string => {
    if (shown || !stdout.decorative) return "";
    shown = true;
    return full ? "FULL BRAND" : "COMPACT BRAND";
  });
  const output: Presentation = { ...makeOutput(stdout, stderr), banner };
  return { output, banner };
};

const help = (overrides: Partial<HelpDoc.HelpDoc> = {}): HelpDoc.HelpDoc => ({
  description: "A generated command description.",
  usage: "tool <subcommand> [flags] <target> [<files...>]",
  annotations: Context.empty(),
  args: [
    {
      name: "target",
      type: "directory",
      description: Option.some("Destination directory"),
      required: true,
      variadic: false,
    },
    { name: "files", type: "file", description: Option.some("Files to upload"), required: false, variadic: true },
  ],
  flags: [
    {
      name: "region",
      aliases: ["-r", "--location"],
      type: "string",
      description: Option.some("Deployment region (choices: east, west)"),
      required: true,
    },
    {
      name: "retries",
      aliases: [],
      type: "integer",
      description: Option.some("Retry count (default: 3)"),
      required: false,
    },
    { name: "verbose", aliases: ["-v"], type: "boolean", description: Option.none(), required: false },
  ],
  globalFlags: [
    { name: "help", aliases: ["-h"], type: "boolean", description: Option.some("Show help"), required: false },
    {
      name: "config",
      aliases: ["-c"],
      type: "file",
      description: Option.some("Global configuration"),
      required: false,
    },
  ],
  subcommands: [
    {
      group: undefined,
      commands: [
        {
          name: "deploy",
          alias: "d",
          shortDescription: "Deploy now",
          description: "Deploy the application to its destination",
        },
      ],
    },
    {
      group: "Maintenance",
      commands: [{ name: "clean", alias: undefined, shortDescription: undefined, description: "Remove stale files" }],
    },
    {
      group: undefined,
      commands: [{ name: "inspect", alias: "i", shortDescription: undefined, description: "Inspect current state" }],
    },
  ],
  examples: [
    { description: "Deploy to the eastern region", command: "tool deploy --region east ./app" },
    { command: "tool inspect --verbose" },
  ],
  ...overrides,
});

const plain = CliOutput.defaultFormatter({ colors: false });

// Wrap-aware comparisons keep the tests independent of Layout's column widths.
const words = (value: string) => clean(value).replace(/\s+/gu, " ").trim();

describe("help formatter", () => {
  it.each([120, 80, 40, 24])("preserves generated help semantics at width %i", (width) => {
    const { output } = presentation(capabilities({ width }));
    const result = words(makeFormatter(output).formatHelpDoc(help()));
    for (const value of [
      "A generated command description.",
      "DESCRIPTION",
      "USAGE",
      "ARGUMENTS",
      "FLAGS",
      "GLOBAL FLAGS",
      "EXAMPLES",
      "tool <subcommand> [flags] <target> [<files...>]",
      "target directory",
      "Destination directory",
      "(required)",
      "files... file",
      "Files to upload",
      "(optional)",
      "--region, -r, --location string",
      "Deployment region (choices: east, west)",
      "--retries integer",
      "Retry count (default: 3)",
      "--verbose, -v boolean",
      "--help, -h boolean",
      "Show help",
      "--config, -c file",
      "Global configuration",
      "deploy, d",
      "Deploy now",
      "Deploy the application to its destination",
      "Maintenance",
      "clean",
      "Remove stale files",
      "inspect, i",
      "Inspect current state",
      "Deploy to the eastern region",
      "tool deploy --region east ./app",
      "tool inspect --verbose",
    ])
      expect(result).toContain(value);
  });

  it("wraps help prose before handing rows to the copy-preserving layout", () => {
    const { output } = presentation(capabilities({ width: 24 }));
    const description = "Long explanatory prose that should fit within a narrow terminal.";
    const result = makeFormatter(output).formatHelpDoc(
      help({
        description: "",
        usage: "tool [flags]",
        args: [{ name: "path", type: "file", description: Option.some(description), required: true, variadic: false }],
        flags: [{ name: "mode", aliases: [], type: "string", description: Option.some(description), required: false }],
        globalFlags: [
          { name: "log", aliases: [], type: "string", description: Option.some(description), required: false },
        ],
        subcommands: [
          { group: undefined, commands: [{ name: "run", alias: undefined, shortDescription: undefined, description }] },
        ],
        examples: [],
      }),
    );
    expect(words(result).split(description)).toHaveLength(5);
    for (const line of result.split("\n")) expect(line.length).toBeLessThanOrEqual(24);
  });

  it("keeps example commands copyable without changing quoted whitespace or inserting line breaks", () => {
    const { output } = presentation(capabilities({ color: 24, width: 24 }));
    const command = 'tool deploy --message "keep  two spaces" https://example.com/very/long/path';
    const result = stripVTControlCharacters(makeFormatter(output).formatHelpDoc(help({ examples: [{ command }] })));
    expect(result).toContain(command);
  });

  it("renders every subcommand group in input order, including repeated ungrouped sections", () => {
    const { output } = presentation();
    const result = makeFormatter(output).formatHelpDoc(help());
    expect(result.indexOf("deploy, d")).toBeLessThan(result.indexOf("Maintenance"));
    expect(result.indexOf("Maintenance")).toBeLessThan(result.indexOf("inspect, i"));
  });

  it("marks required flags even when their descriptions do not", () => {
    const { output } = presentation();
    const result = words(
      makeFormatter(output).formatHelpDoc(help({ args: [], globalFlags: [], subcommands: [], examples: [] })),
    );
    expect(result).toContain("Deployment region (choices: east, west) (required)");
    expect(result).toContain("Retry count (default: 3) (optional)");
  });

  it.each(["tool [flags]", "tool <subcommand> [flags]"])("requests a full banner for root usage %s", (usage) => {
    const { output, banner } = presentation();
    expect(makeFormatter(output).formatHelpDoc(help({ usage }))).toContain("FULL BRAND");
    expect(banner).toHaveBeenCalledWith(true);
  });

  it.each(["tool nested [flags]", "tool nested deep <subcommand> [flags]"])(
    "requests a compact banner for nested usage %s",
    (usage) => {
      const { output, banner } = presentation();
      expect(makeFormatter(output).formatHelpDoc(help({ usage }))).toContain("COMPACT BRAND");
      expect(banner).toHaveBeenCalledWith(false);
    },
  );

  it("uses presentation-scoped banner state and never adds a banner to errors or version", () => {
    const { output, banner } = presentation();
    const formatter = makeFormatter(output);
    expect(formatter.formatHelpDoc(help())).toContain("FULL BRAND");
    expect(formatter.formatHelpDoc(help())).not.toContain("BRAND");
    expect(formatter.formatVersion("tool", "1.2.3")).toBe("tool v1.2.3");
    expect(formatter.formatError(new CliError.MissingOption({ option: "region" }))).not.toContain("BRAND");
    expect(banner).toHaveBeenCalledTimes(2);
  });

  it("delegates nondecorative help exactly to Effect without consuming the banner", () => {
    const { output, banner } = presentation(capabilities({ decorative: false, color: 24 }));
    const formatter = makeFormatter(output);
    const doc = help();
    expect(formatter.formatHelpDoc(doc)).toBe(plain.formatHelpDoc(doc));
    expect(formatter.formatHelpDoc(doc)).not.toContain("\x1b");
    expect(banner).not.toHaveBeenCalled();
  });

  it("omits empty sections without inventing command inventory", () => {
    const { output } = presentation();
    const result = makeFormatter(output).formatHelpDoc({
      usage: "arbitrary-tool [flags]",
      description: "",
      flags: [],
      annotations: Context.empty(),
    });
    expect(result).toContain("arbitrary-tool [flags]");
    for (const title of ["DESCRIPTION", "ARGUMENTS", "FLAGS", "SUBCOMMANDS", "EXAMPLES"]) {
      expect(result).not.toContain(title);
    }
  });

  it.each([true, false])("sanitizes all external help fields (decorative=%s)", (decorative) => {
    const unsafe = "safe\x1b[31m\x1b]2;injected\x07\x1b[2J\r\x00\x85\x9b31mtext";
    const { output } = presentation(capabilities({ decorative }));
    const doc = help({
      description: unsafe,
      usage: `${unsafe} [flags]`,
      args: [{ name: unsafe, type: unsafe, description: Option.some(unsafe), required: true, variadic: true }],
      flags: [{ name: unsafe, aliases: [unsafe], type: unsafe, description: Option.some(unsafe), required: true }],
      globalFlags: [
        { name: unsafe, aliases: [unsafe], type: unsafe, description: Option.some(unsafe), required: false },
      ],
      subcommands: [
        { group: unsafe, commands: [{ name: unsafe, alias: unsafe, shortDescription: unsafe, description: unsafe }] },
      ],
      examples: [{ command: unsafe, description: unsafe }],
    });
    const result = makeFormatter(output).formatHelpDoc(doc);
    expect(result).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
    expect(result).toContain("safe");
    expect(result).toContain("text");
  });
});

describe("error and version formatter", () => {
  const errors = [
    new CliError.UnrecognizedOption({
      option: "--regoin",
      command: ["tool", "deploy"],
      suggestions: ["--region", "--retries"],
    }),
    new CliError.MissingOption({ option: "target" }),
    new CliError.UnrecognizedOption({ option: "--forse", suggestions: ["--force"] }),
  ];

  it.each([0, 4, 8, 24] as const)("preserves errors and suggestions with stderr color depth %i", (color) => {
    const { output } = presentation(capabilities({ decorative: false }), capabilities({ color }));
    const formatter = makeFormatter(output);
    expect(stripVTControlCharacters(formatter.formatCliError(errors[0]!))).toBe(plain.formatCliError(errors[0]!));
    expect(stripVTControlCharacters(formatter.formatError(errors[0]!))).toBe(plain.formatError(errors[0]!));
    expect(stripVTControlCharacters(formatter.formatErrors(errors))).toBe(plain.formatErrors(errors));
    const result = stripVTControlCharacters(formatter.formatErrors(errors));
    for (const value of ["Did you mean this?", "--region", "--retries", "--force", "target", "tool deploy"]) {
      expect(result).toContain(value);
    }
    if (color !== 0) expect(formatter.formatError(errors[0]!)).toContain("\x1b[");
  });

  it("keeps redirected stderr plain even when stdout supports color", () => {
    const { output } = presentation(capabilities({ color: 24 }), capabilities({ decorative: false, color: 24 }));
    const formatter = makeFormatter(output);
    expect(formatter.formatCliError(errors[0]!)).toBe(plain.formatCliError(errors[0]!));
    expect(formatter.formatError(errors[0]!)).toBe(plain.formatError(errors[0]!));
    expect(formatter.formatErrors(errors)).toBe(plain.formatErrors(errors));
  });

  it.each([0, 24] as const)("preserves empty and single-error behavior at color depth %i", (color) => {
    const { output } = presentation(capabilities({ color }));
    const formatter = makeFormatter(output);
    expect(formatter.formatErrors([])).toBe("");
    expect(stripVTControlCharacters(formatter.formatErrors([errors[0]!]))).toBe(plain.formatErrors([errors[0]!]));
  });

  it("sanitizes error messages, suggestions, names, and versions", () => {
    const { output } = presentation();
    const formatter = makeFormatter(output);
    const unsafe = "value\x1b[2J\r\x9b2J";
    const error = new CliError.UnrecognizedOption({ option: unsafe, suggestions: [unsafe] });
    for (const result of [
      formatter.formatCliError(error),
      formatter.formatError(error),
      formatter.formatErrors([error]),
      formatter.formatVersion(unsafe, unsafe),
    ])
      expect(result).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
  });
});

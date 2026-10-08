import width from "string-width";

import { clean, paint, type Capabilities, type Tone } from "./Theme.ts";

export { width };

export const wrap = (text: string, columns: number): string[] =>
  clean(text)
    .split("\n")
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        if (line && width(`${line} ${word}`) > Math.max(1, columns)) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      lines.push(line);
      return lines;
    });

export const heading = (caps: Capabilities, title: string): string => {
  const label = clean(title);
  if (!caps.decorative) return label;
  if (caps.width < 24) return paint(caps, "primary", label);
  const rule = caps.unicode ? "─" : "-";
  const corner = caps.unicode ? "╭" : "+";
  const rest = Math.max(0, Math.min(caps.width - 2, 76) - width(label) - 5);
  return `  ${paint(caps, "dim", `${corner}${rule} `)}${paint(caps, "primary", label)} ${paint(caps, "dim", rule.repeat(rest))}`;
};

export const rows = (
  caps: Capabilities,
  items: ReadonlyArray<readonly [string, string]>,
  labelTone: Tone = "muted",
): string => {
  const fields = items.map(([label, value]) => [clean(label), clean(value)] as const);
  if (!caps.decorative) return fields.map(([label, value]) => `${label}: ${value}`).join("\n");
  const labelWidth = Math.min(24, Math.max(0, ...fields.map(([label]) => width(label))));
  return fields
    .map(([label, value]) => {
      const prefix = `  ${paint(caps, labelTone, label)}${" ".repeat(Math.max(2, labelWidth - width(label) + 2))}`;
      if (caps.width < 50 || width(label) > 24 || value.includes("\n") || width(value) + labelWidth + 4 > caps.width) {
        return `  ${paint(caps, labelTone, label)}\n${value
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}`;
      }
      return `${prefix}${value}`;
    })
    .join("\n");
};

import { usdFromMicros, type UsageSpend } from "@impact-llm/schemas";

import * as Layout from "./Layout.ts";
import { clean, type Capabilities } from "./Theme.ts";

const usd = (micros: number): string => `$${usdFromMicros(micros).toFixed(2)} USD`;
const label = (name: string): string => clean(name).replace(/\n/g, "\\n");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Unlike copyable paths, display names may wrap even when they contain no spaces.
const wrapLabel = (text: string, columns: number): string[] =>
  Layout.wrap(text, columns).flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    for (const { segment } of graphemes.segment(line)) {
      if (current && Layout.width(current + segment) > columns) {
        lines.push(current);
        current = "";
      }
      current += segment;
    }
    lines.push(current);
    return lines;
  });

const fitLabel = (text: string, columns: number, unicode: boolean): string => {
  if (Layout.width(text) <= columns) return text;
  const suffix = unicode ? "…" : ".".repeat(Math.min(3, columns));
  let clipped = "";
  for (const { segment } of graphemes.segment(text)) {
    if (Layout.width(clipped + segment) > columns - Layout.width(suffix)) break;
    clipped += segment;
  }
  return clipped + suffix;
};
/** Floor to terminal resolution: never turn a zero or sub-cell amount into a full bar. */
const bar = (value: number, maximum: number, columns: number, unicode: boolean): string => {
  if (maximum <= 0 || value <= 0) return "";
  const cells = Math.min(columns, (value / maximum) * columns);
  const full = Math.floor(cells);
  const fraction = unicode ? " ▏▎▍▌▋▊▉"[Math.floor((cells - full) * 8)]!.trim() : "";
  return (unicode ? "█" : "#").repeat(full) + fraction;
};

/** All bars share a zero baseline and scale; terminal foreground supplies the neutral ink. */
export const renderSpend = (caps: Capabilities, spend: UsageSpend | undefined): string => {
  const title = `Spend ${caps.unicode ? "·" : "-"} last 7 days`;
  const indent = caps.decorative ? "  " : "";
  const columns = Math.max(1, caps.width - indent.length);
  const text = (value: string) =>
    wrapLabel(value, columns)
      .map((line) => indent + line)
      .join("\n");
  const heading = caps.width < Layout.width(title) + 7 ? text(title) : Layout.heading(caps, title);
  const lines = [heading];
  if (!spend) return [...lines, text("Spending data unavailable")].join("\n");
  lines.push(Layout.rows(caps, [["Total", usd(spend.totalMicros)]]));
  if (spend.models.length === 0)
    return [
      ...lines,
      text(spend.totalMicros === 0 ? "No spending in this period." : "Model breakdown unavailable."),
    ].join("\n");
  const models = spend.models.map((model) => ({
    name: label(model.name),
    amount: usd(model.chargedMicros),
    chargedMicros: model.chargedMicros,
  }));
  if (!caps.decorative)
    return [
      ...lines,
      Layout.rows(
        caps,
        models.map(({ name, amount }) => [name, amount]),
      ),
    ].join("\n");
  const maximum = Math.max(0, ...models.map((model) => model.chargedMicros));
  const amountWidth = Math.max(...models.map((model) => Layout.width(model.amount)));
  const room = columns - amountWidth - 4;
  const showBars = room >= 16;
  const nameWidth = Math.min(
    Math.max(...models.map((model) => Layout.width(model.name))),
    Math.max(1, showBars ? Math.floor(room / 2) : columns - amountWidth - 2),
  );
  const barWidth = showBars ? Math.min(32, room - nameWidth) : 0;
  for (const model of models) {
    if (columns < amountWidth + 3) {
      lines.push(text(model.name), text(model.amount));
      continue;
    }
    const name = fitLabel(model.name, nameWidth, caps.unicode);
    const nameColumn = name + " ".repeat(nameWidth - Layout.width(name));
    const mark = bar(model.chargedMicros, maximum, barWidth, caps.unicode);
    const barColumn = showBars ? `${mark}${" ".repeat(barWidth - Layout.width(mark))}  ` : "";
    lines.push(`${indent}${nameColumn}  ${barColumn}${model.amount.padStart(amountWidth)}`);
  }
  return lines.join("\n");
};

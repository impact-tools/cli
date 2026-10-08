import { width } from "./Layout.ts";
import { paint, type Capabilities, type Tone } from "./Theme.ts";

// Terminal adaptation of the web MARK grid: two sparkles, faded rays and a lime satellite.
const mark = [
  "..............",
  ".....d........",
  ".....m.....a..",
  ".....m.....a..",
  ".....#...aaaaa",
  "....###....a..",
  "....###....a..",
  ".dm#####md....",
  "....###.......",
  "....###.......",
  ".....#........",
  ".....m.....b..",
  ".d...m........",
  ".....d........",
];

const letters: Record<string, readonly string[]> = {
  I: ["###", ".#.", ".#.", ".#.", "###"],
  m: [".....", "##.#.", "#.#.#", "#.#.#", "#.#.#"],
  p: ["....", "###.", "#..#", "###.", "#..."],
  a: ["....", ".##.", "...#", ".###", "####"],
  c: ["....", ".###", "#...", "#...", ".###"],
  t: [".#.", "###", ".#.", ".#.", ".##"],
  " ": ["..", "..", "..", "..", ".."],
  L: ["#...", "#...", "#...", "#...", "####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
};
const word = Array.from("Impact LLM");
const lettering = Array.from({ length: 5 }, (_, row) => word.map((letter) => letters[letter]![row]).join("."));

const sparkle = (caps: Capabilities): string[] =>
  Array.from({ length: 7 }, (_, row) => {
    return Array.from({ length: 14 }, (_, column) => {
      const top = mark[row * 2]![column]!;
      const bottom = mark[row * 2 + 1]![column]!;
      if (top === "." && bottom === ".") return " ";
      const cells = top + bottom;
      const tone: Tone = cells.includes("a")
        ? "primary"
        : cells.includes("b")
          ? "accent"
          : cells.includes("#")
            ? "foreground"
            : cells.includes("m")
              ? "muted"
              : "dim";
      const pixel = caps.unicode
        ? top === "."
          ? "▄"
          : bottom === "."
            ? "▀"
            : "█"
        : tone === "dim"
          ? "."
          : tone === "muted"
            ? ":"
            : "+";
      return paint(caps, tone, pixel);
    }).join("");
  });

export const logo = (caps: Capabilities, full = true): string => {
  if (!caps.decorative) return "";
  const name = "Impact LLM";
  if (!full || caps.width < 72) {
    const stars = caps.unicode ? "✦ ˖" : "+ *";
    const line = caps.width >= 18 ? `  ${paint(caps, "primary", stars)}  ${name}` : name;
    return `\n${line}\n`;
  }
  const star = sparkle(caps);
  const pixels = lettering.map((row) =>
    paint(caps, "primary", row.replace(/\./g, " ").replace(/#/g, caps.unicode ? "█" : "#")),
  );
  // Uneven trails stay attached to letter strokes; the top of the word remains legible.
  const base = lettering[4]!;
  const trails = [0, 1, 2].map((row) =>
    Array.from(base, (pixel, column) => {
      if (pixel !== "#" || (column * 7 + 3) % 5 < row + 1) return " ";
      const character = caps.unicode ? ["▓", "▒", "░"][row]! : ["|", ":", "."][row]!;
      return paint(caps, row === 0 ? "primary" : row === 1 ? "muted" : "dim", character);
    }).join(""),
  );
  const text = [...pixels, ...trails];
  const lines = text.map((line, row) => `  ${star[row] ?? " ".repeat(14)}  ${line}`.trimEnd());
  return `\n${lines.filter((line) => width(line) > 0).join("\n")}\n`;
};

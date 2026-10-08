import { Prompt } from "effect/cli";

export type Tone = keyof typeof colors;

export interface Capabilities {
  readonly decorative: boolean;
  readonly color: 0 | 4 | 8 | 24;
  readonly unicode: boolean;
  readonly width: number;
}

interface Terminal {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly getColorDepth?: () => number;
}

// RGB, 256-color and basic ANSI representations of each semantic tone.
const colors = {
  primary: ["202;170;235", 183, 35],
  foreground: ["237;237;238", 255, 39],
  muted: ["152;152;154", 246, 37],
  dim: ["110;110;115", 242, 90],
  accent: ["228;230;41", 185, 33],
  success: ["110;233;168", 84, 32],
  warning: ["255;176;32", 214, 33],
  error: ["255;125;136", 210, 31],
} as const;

export const capabilities = (stream: Terminal, env: NodeJS.ProcessEnv = process.env): Capabilities => {
  const decorative = stream.isTTY === true && env.TERM !== "dumb" && !env.CI;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  const unicode = decorative && locale !== "C" && locale !== "POSIX";
  let color: Capabilities["color"] = 0;
  if (decorative && env.NO_COLOR === undefined && env.FORCE_COLOR !== "0") {
    const depth =
      env.FORCE_COLOR === "3" || /truecolor|24bit/i.test(env.COLORTERM ?? "")
        ? 24
        : env.FORCE_COLOR === "2"
          ? 8
          : env.FORCE_COLOR !== undefined
            ? 4
            : (stream.getColorDepth?.() ?? (/256color/.test(env.TERM ?? "") ? 8 : 4));
    color = depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 0;
  }
  return { decorative, color, unicode, width: Math.max(1, stream.columns || 80) };
};

// Escape untrusted controls before applying our own terminal styles.
export const clean = (text: string): string =>
  text
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(/\t/g, "  ");

const colorCode = (caps: Capabilities, tone: Tone): string => {
  if (!caps.color) return "";
  // Body text inherits the user's foreground, including on light terminals.
  if (tone === "foreground") return "\x1b[39m";
  const [rgb, indexed, basic] = colors[tone];
  if (caps.color === 4) return `\x1b[${basic}m`;
  if (caps.color === 8) return `\x1b[38;5;${indexed}m`;
  return `\x1b[38;2;${rgb}m`;
};

export const paint = (caps: Capabilities, tone: Tone, text: string): string => {
  const code = colorCode(caps, tone);
  return code ? `${code}${text}\x1b[0m` : text;
};

export const promptTheme = (caps: Capabilities): Prompt.Theme =>
  Prompt.makeTheme({
    prefix: caps.unicode ? "◇" : "?",
    pointer: caps.unicode ? "▸" : ">",
    pointerSmall: caps.unicode ? "›" : ">",
    tick: caps.unicode ? "✓" : "+",
    ellipsis: caps.unicode ? "…" : "...",
    arrowUp: caps.unicode ? "↑" : "^",
    arrowDown: caps.unicode ? "↓" : "v",
    checkboxOn: caps.unicode ? "◼" : "[x]",
    checkboxOff: caps.unicode ? "◻" : "[ ]",
    descriptionSeparator: caps.unicode ? "─" : "-",
    passwordMask: "*",
    toggleSeparator: "/",
    primaryColor: colorCode(caps, "primary"),
    mutedColor: colorCode(caps, "muted"),
    successColor: colorCode(caps, "success"),
    errorColor: colorCode(caps, "error"),
    submittedColor: colorCode(caps, "foreground"),
  });

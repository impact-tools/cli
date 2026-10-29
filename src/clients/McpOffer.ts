import { Effect, Stdio } from "effect";
import { Prompt } from "effect/cli";

import { readMcpSettings, saveMcpSettings } from "../config/Mcp.ts";
import { MCP_DOCS_URL, MCP_SERVER_IDS, MCP_SERVERS } from "../setup/Mcp.ts";
import { Output } from "../ui/Output.ts";

type Answer = "enable" | "later" | "never";

/**
 * Before a launch that can add Impact's MCP servers, asks once whether to turn on those that are off
 * and that the reader hasn't declined for good. "Not now" asks again next launch; "Don't ask again"
 * remembers. Never asks without an interactive terminal, nor when `IMPACT_MCP` chooses for the launch.
 */
export const offerMcp = Effect.fnUntraced(function* () {
  const stdio = yield* Stdio.Stdio;
  if (process.env.IMPACT_MCP !== undefined || !(yield* stdio.stdinIsTerminal) || !process.stdout.isTTY) return;
  const saved = yield* readMcpSettings;
  const offered = MCP_SERVER_IDS.filter(
    (server) => !saved.enabled.includes(server) && !saved.dismissed.includes(server),
  );
  if (offered.length === 0) return;
  const names = offered.map((server) => MCP_SERVERS[server].label).join(" and ");
  const answer = yield* Prompt.Select<Answer>({
    message: `Add ${names} to your sessions? ${MCP_DOCS_URL}`,
    choices: [
      { title: "Yes, turn on", value: "enable", description: "Change it later with impact mcp" },
      { title: "Not now", value: "later" },
      { title: "No, don't ask again", value: "never" },
    ],
  }).pipe(Effect.catchTag("QuitError", () => Effect.succeed<Answer>("later")));
  if (answer === "later") return;
  const output = yield* Output;
  if (answer === "never") {
    yield* saveMcpSettings({ ...saved, dismissed: [...saved.dismissed, ...offered] });
    return yield* output.line("Turn them on any time with impact mcp enable context7 firecrawl.");
  }
  yield* saveMcpSettings({ ...saved, enabled: [...saved.enabled, ...offered] });
  yield* output.notice("success", `${names} on. Turn off with impact mcp disable.`);
});

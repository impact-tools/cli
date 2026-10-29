import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { mcpFile, readMcpSettings, setMcpServers } from "../config/Mcp.ts";
import { CliError } from "../Errors.ts";
import { isMcpServer, MCP_DOCS_URL, MCP_SERVER_IDS, MCP_SERVERS, mcpUrl, type McpServer } from "../setup/Mcp.ts";
import { Output } from "../ui/Output.ts";

/** The launches that add the enabled servers; Cursor and Antigravity keep their own MCP settings. */
const LAUNCHES = "impact claude, impact codex, impact opencode and impact kilo";

const names = Argument.String("server").pipe(
  Argument.variadic({ min: 1 }),
  Argument.withDescription(`${MCP_SERVER_IDS.join(" or ")}`),
);

const parseServers = (values: readonly string[]) =>
  Effect.gen(function* () {
    const unknown = values.filter((value) => !isMcpServer(value));
    if (unknown.length > 0)
      return yield* new CliError({
        message: `Unknown MCP server ${unknown.join(", ")}. Choose ${MCP_SERVER_IDS.join(" or ")}.`,
      });
    return values as McpServer[];
  });

const showServers = Effect.fn(function* () {
  const output = yield* Output;
  const settings = yield* readMcpSettings;
  yield* output.rows(
    MCP_SERVER_IDS.map((server) => [MCP_SERVERS[server].label, settings.enabled.includes(server) ? "On" : "Off"]),
    MCP_SERVER_IDS.map((server) => `${server}: ${settings.enabled.includes(server) ? "on" : "off"}`).join("\n"),
  );
});

const enable = Command.make(
  "enable",
  { servers: names },
  Effect.fn(function* ({ servers }) {
    const output = yield* Output;
    const chosen = yield* parseServers(servers);
    yield* setMcpServers(chosen, true);
    yield* output.notice(
      "success",
      `${chosen.map((server) => MCP_SERVERS[server].label).join(" and ")} on: ${LAUNCHES} add it from the next launch.`,
    );
  }),
).pipe(Command.withDescription("Add Impact's MCP servers to every launch"));

const disable = Command.make(
  "disable",
  { servers: names },
  Effect.fn(function* ({ servers }) {
    const output = yield* Output;
    const chosen = yield* parseServers(servers);
    yield* setMcpServers(chosen, false);
    yield* output.notice("success", `${chosen.map((server) => MCP_SERVERS[server].label).join(" and ")} off.`);
  }),
).pipe(Command.withDescription("Stop adding Impact's MCP servers to launches"));

const list = Command.make("list", {}, showServers).pipe(Command.withDescription("Show which MCP servers launches add"));

/** `impact mcp`: Impact's MCP servers (Context7, Firecrawl) in launches, paid like any request on the login's key. */
export const mcp = Command.make(
  "mcp",
  {},
  Effect.fn(function* () {
    const output = yield* Output;
    yield* output.start("MCP servers");
    yield* showServers();
    yield* output.line("");
    yield* output.rows([
      ["Turn on", "impact mcp enable context7 firecrawl"],
      ["Turn off", "impact mcp disable firecrawl"],
      ["Settings", mcpFile()],
      ["Docs", MCP_DOCS_URL],
      ...MCP_SERVER_IDS.map((server) => [`${MCP_SERVERS[server].label} URL`, mcpUrl(server)] as const),
    ]);
  }),
).pipe(
  Command.withSubcommands([enable, disable, list]),
  Command.withDescription("Context7 and Firecrawl in impact claude, codex, opencode and kilo"),
  Command.withShortDescription("Context7 and Firecrawl MCP servers"),
);

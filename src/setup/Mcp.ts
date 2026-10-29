import type { SetupTool } from "./Setup.ts";

import { exportLines, homeFile } from "./Shell.ts";
import {
  API_ORIGIN,
  APP_ORIGIN,
  codeStep,
  commandStep,
  fieldsStep,
  jsonCode,
  type SetupOptions,
  type SetupStep,
} from "./Steps.ts";

/** The MCP servers Impact serves on an Impact key, by the name a client lists them under. */
export const MCP_SERVERS = {
  context7: { label: "Context7", path: "/mcp/context7" },
  firecrawl: { label: "Firecrawl", path: "/mcp/firecrawl" },
} as const;

export type McpServer = keyof typeof MCP_SERVERS;

export const MCP_SERVER_IDS = Object.keys(MCP_SERVERS) as McpServer[];

/** What the servers do, what they cost and how to add them elsewhere. */
export const MCP_DOCS_URL = `${APP_ORIGIN}/docs/mcp`;

export const isMcpServer = (name: string): name is McpServer => Object.hasOwn(MCP_SERVERS, name);

/** Where Impact serves `server`; `origin` is Impact's API origin, or a local proxy that adds the key. */
export const mcpUrl = (server: McpServer, origin = API_ORIGIN) => `${origin}${MCP_SERVERS[server].path}`;

const byName = <Value>(servers: readonly McpServer[], entry: (server: McpServer) => Value) =>
  Object.fromEntries(servers.map((server) => [server, entry(server)]));

/**
 * Claude Code's MCP servers for a launch (`--mcp-config`): `headersHelper` is a command that prints
 * the key as a header when Claude connects, so the key never sits in Claude's arguments or settings.
 */
export const claudeMcpConfig = (servers: readonly McpServer[], origin: string, headersHelper: string) => ({
  mcpServers: byName(servers, (server) => ({ type: "http", url: mcpUrl(server, origin), headersHelper })),
});

/** The `impact` key's MCP servers in the format OpenCode and its fork Kilo share; the key comes from `IMPACT_API_KEY`. */
export const openCodeMcp = (servers: readonly McpServer[], origin: string) =>
  byName(servers, (server) => ({
    type: "remote",
    url: mcpUrl(server, origin),
    oauth: false,
    headers: { Authorization: "Bearer {env:IMPACT_API_KEY}" },
  }));

/** Codex's `mcp_servers` table for a launch, at the local proxy that adds the key: Codex never sees it. */
export const codexMcpServers = (servers: readonly McpServer[], proxyUrl: string) =>
  byName(servers, (server) => ({ url: mcpUrl(server, proxyUrl) }));

/** The tools whose MCP setup the docs show; any other tool takes the URL and the header. */
export const MCP_TOOLS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "other",
] as const satisfies readonly SetupTool[];

export type McpTool = (typeof MCP_TOOLS)[number];

const header = (apiKey: string) => `Bearer ${apiKey}`;

/** How to add `servers` to `tool` by hand, with the key in `options`. */
export function mcpSteps(tool: McpTool, servers: readonly McpServer[], options: SetupOptions): SetupStep[] {
  const origin = options.baseUrl ?? API_ORIGIN;
  switch (tool) {
    case "claude-code":
      return [
        commandStep(
          "run",
          options.platform,
          servers.map(
            (server) =>
              `claude mcp add --scope user --transport http ${server} ${mcpUrl(server, origin)} --header "Authorization: ${header(options.apiKey)}"`,
          ),
        ),
      ];
    case "codex":
      return [
        codeStep(
          "settings",
          "toml",
          servers
            .map((server) =>
              [
                `[mcp_servers.${server}]`,
                `url = "${mcpUrl(server, origin)}"`,
                `bearer_token_env_var = "IMPACT_API_KEY"`,
              ].join("\n"),
            )
            .join("\n\n"),
          homeFile(options.platform, ".codex", "config.toml"),
        ),
        commandStep("key", options.platform, exportLines(options.platform, { IMPACT_API_KEY: options.apiKey })),
      ];
    case "cursor":
      return [
        codeStep(
          "settings",
          "json",
          jsonCode({
            mcpServers: byName(servers, (server) => ({
              url: mcpUrl(server, origin),
              headers: { Authorization: header(options.apiKey) },
            })),
          }),
          homeFile(options.platform, ".cursor", "mcp.json"),
        ),
      ];
    case "opencode":
      return [
        codeStep(
          "settings",
          "json",
          jsonCode({ $schema: "https://opencode.ai/config.json", mcp: openCodeMcp(servers, origin) }),
          "opencode.json",
        ),
        commandStep("key", options.platform, exportLines(options.platform, { IMPACT_API_KEY: options.apiKey })),
      ];
    case "other":
      return [
        fieldsStep([
          ...servers.map((server) => ({ label: `${MCP_SERVERS[server].label} URL`, value: mcpUrl(server, origin) })),
          { label: "Transport", value: "Streamable HTTP" },
          { label: "Authorization", value: header(options.apiKey) },
        ]),
      ];
  }
}

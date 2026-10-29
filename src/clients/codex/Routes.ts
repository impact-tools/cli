import { MCP_SERVER_IDS, MCP_SERVERS } from "../../setup/Mcp.ts";

/**
 * Every Impact route Codex calls, under both of its bases: the provider's `/v1` and the ChatGPT
 * backend's `/backend-api/codex`. The proxy forwards exactly these paths.
 */
const NATIVE = ["models", "responses", "responses/compact", "images/generations", "images/edits"] as const;

export const CODEX_ROUTES: readonly string[] = [
  ...["/v1", "/backend-api/codex"].flatMap((base) => NATIVE.map((path) => `${base}/${path}`)),
  "/api/codex/usage",
];

/** Impact's MCP servers (`impact mcp enable`), which Codex reaches through the proxy so it never holds the key. */
export const CODEX_MCP_ROUTES: readonly string[] = MCP_SERVER_IDS.map((server) => MCP_SERVERS[server].path);

/**
 * Impact routes the Codex proxy deliberately refuses, with the reason. A path ending in `/*` closes
 * everything below it. `test/proxy-routes.test.ts` fails on a server route in neither list.
 */
export const CLOSED_CODEX_ROUTES: Readonly<Record<string, string>> = {
  "/v1/chat/completions": "Codex speaks only the Responses API",
  "/v1/messages": "Codex speaks only the Responses API",
  "/v1/messages/count_tokens": "Codex speaks only the Responses API",
  "/v1/models/:model": "Codex reads the whole catalog",
  "/v1/usage": "the CLI reads the balance itself; Codex polls /api/codex/usage",
  "/v1/usage/spend": "spending is shown by impact status",
  "/v1/keys/self/revoke": "a client must never revoke the key it runs on",
  "/v1/alpha/*": "server-side context management is off on Impact",
  "/backend-api/codex/alpha/*": "server-side context management is off on Impact",
};

const forwarded = new Set([...CODEX_ROUTES, ...CODEX_MCP_ROUTES]);

/** `path` without its query. */
export const pathname = (path: string) => path.split("?", 1)[0] ?? path;

/** Whether the proxy forwards `path` (query included) to Impact. */
export const isCodexRoute = (path: string) => forwarded.has(pathname(path));

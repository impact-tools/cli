import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";

import { mapPlatformError } from "../Errors.ts";
import { MCP_SERVER_IDS, type McpServer } from "../setup/Mcp.ts";
import { configDirectory } from "./Credentials.ts";

const Server = Schema.Literals(MCP_SERVER_IDS);

/** Which of Impact's MCP servers launches add, and whether the one-time offer was answered for good. */
const McpSettings = Schema.Struct({
  enabled: Schema.Array(Server),
  /** The servers the offer asked about and the reader said never to ask again. */
  dismissed: Schema.Array(Server),
});
export type McpSettings = typeof McpSettings.Type;

const McpJson = Schema.fromJsonString(McpSettings);

const NONE: McpSettings = { enabled: [], dismissed: [] };

export const mcpFile = () => join(configDirectory(), "mcp.json");

/** The saved settings; nothing on, nothing dismissed when the file is missing or unreadable. */
export const readMcpSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(mcpFile()).pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return NONE;
  return yield* Schema.decodeEffect(McpJson)(contents).pipe(Effect.orElseSucceed(() => NONE));
});

export const saveMcpSettings = Effect.fn("saveMcpSettings")(
  function* (settings: McpSettings) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(configDirectory(), { recursive: true, mode: 0o700 });
    const temporary = yield* fs.makeTempFileScoped({ directory: configDirectory(), prefix: ".mcp-" });
    const ordered = (servers: readonly McpServer[]) => MCP_SERVER_IDS.filter((server) => servers.includes(server));
    const value = { enabled: ordered(settings.enabled), dismissed: ordered(settings.dismissed) };
    yield* fs.writeFileString(temporary, `${yield* Schema.encodeEffect(McpJson)(value).pipe(Effect.orDie)}\n`);
    yield* fs.rename(temporary, mcpFile());
  },
  Effect.scoped,
  mapPlatformError("Cannot save the MCP settings"),
);

/** The servers launches add; an `IMPACT_MCP` list (`context7,firecrawl`, or empty) overrides the saved ones. */
export const enabledMcpServers = Effect.map(readMcpSettings, (settings): readonly McpServer[] => {
  const override = process.env.IMPACT_MCP;
  if (override === undefined) return settings.enabled;
  const named = override.split(",").map((name) => name.trim());
  return MCP_SERVER_IDS.filter((server) => named.includes(server));
});

/** Turns `servers` on or off and saves the result. */
export const setMcpServers = Effect.fn("setMcpServers")(function* (servers: readonly McpServer[], on: boolean) {
  const saved = yield* readMcpSettings;
  const enabled = on
    ? [...new Set([...saved.enabled, ...servers])]
    : saved.enabled.filter((server) => !servers.includes(server));
  const next = { ...saved, enabled };
  yield* saveMcpSettings(next);
  return next;
});

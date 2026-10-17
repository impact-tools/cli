import type { IncomingMessage, ServerResponse } from "node:http";
import { Redacted } from "effect";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Connection } from "../../src/config/Connection.ts";

export async function mockCursorImpact(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No mock address");
  const connection: Connection = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: Redacted.make("sk-imp-test-private") };
  return { connection, server, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

export const accountPayload = { account: { id: "impact-account", email: "person@example.test" }, currency: "USD", credits: { balance: "42.5" } };
export const modelsPayload = { data: [{ id: "impact-model", display_name: "Impact Model", context_length: 64000, capabilities: ["tools"] }] };
export async function requestBody(req: IncomingMessage) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
export const sseEvent = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

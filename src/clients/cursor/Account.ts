import { Schema } from "effect";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Connection } from "../../config/Connection.ts";
import { impactRequest, ProtocolError } from "./Impact.ts";

const Account = Schema.Struct({ id: Schema.String, email: Schema.String });
const Usage = Schema.Struct({ account: Account, currency: Schema.String, credits: Schema.Struct({ balance: Schema.String }) });
const readUsage = Schema.decodeUnknownSync(Usage);
const Refresh = Schema.Struct({ refresh_token: Schema.String });
export const readRefresh = Schema.decodeUnknownSync(Refresh);

export interface CursorModel {
  id: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: readonly string[] | { supports_tool_use?: boolean; supports_vision?: boolean; supports_reasoning?: boolean };
  reasoning_efforts?: readonly string[];
}
const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({
  id: Schema.String, display_name: Schema.optional(Schema.String), context_length: Schema.optional(Schema.Int), max_output_tokens: Schema.optional(Schema.Int),
  capabilities: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Struct({ supports_tool_use: Schema.optional(Schema.Boolean), supports_vision: Schema.optional(Schema.Boolean), supports_reasoning: Schema.optional(Schema.Boolean) })])),
  reasoning_efforts: Schema.optional(Schema.Array(Schema.String)),
})) });
const readModels = Schema.decodeUnknownSync(Models);

export async function impactJson(connection: Connection, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await impactRequest(connection, path, undefined, signal);
  const chunks: Buffer[] = []; let length = 0;
  try {
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new ProtocolError("resource_exhausted", "Impact account response exceeds 1 MiB.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { response.destroy(); }
}

export class CursorAccount {
  readonly id: string;
  readonly email: string;
  readonly refreshToken: string;
  private readonly secret: Buffer;
  private active = true;
  token: string;
  /**
   * Without `key` the session lives only in this process. A persistent `key` derives a per-account
   * signing secret, so tokens survive a proxy restart and stop working when the Impact account changes.
   */
  private constructor(readonly connection: Connection, account: typeof Account.Type, key?: Uint8Array) {
    this.id = account.id; this.email = account.email;
    this.secret = key ? createHmac("sha256", key).update(`impact-cursor-session:${account.id}`).digest() : randomBytes(32);
    this.refreshToken = key ? createHmac("sha256", this.secret).update("refresh").digest("base64url") : randomBytes(32).toString("base64url");
    this.token = this.issue();
  }
  static async load(connection: Connection, signal: AbortSignal, key?: Uint8Array) {
    const [usage, catalog, readableCatalog] = await Promise.all([
      impactJson(connection, "/v1/usage", signal),
      impactJson(connection, "/v1/models?flavor=cursor", signal),
      impactJson(connection, "/v1/models?flavor=anthropic", signal),
    ]);
    const read = readUsage(usage);
    const models = readModels(catalog).data.map((model) => ({ ...model }));
    const readable = new Map(readModels(readableCatalog).data.map((model) => [model.id, model.display_name]));
    for (const model of models) if (!model.display_name) model.display_name = readable.get(model.id);
    if (!models.length) throw new ProtocolError("failed_precondition", "Impact has no enabled models.");
    return { account: new CursorAccount(connection, read.account, key), models, balance: read.credits.balance };
  }
  private signature(payload: string) { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  private issue() {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    // Desktop refreshes 53 days before expiry in 3.16.17. The token is still
    // invalid outside this launch: its signing key lives only in this process.
    const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "impact-local", sub: this.id, email: this.email, iat: now, exp: now + 90 * 86400, jti: randomBytes(16).toString("hex") })}`;
    return `${payload}.${this.signature(payload)}`;
  }
  private authentic(token: string | undefined, allowExpired = false) {
    if (!this.active || !token || token.length > 8192) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const signed = `${parts[0]}.${parts[1]}`;
    const given = Buffer.from(parts[2]!, "utf8"), expected = Buffer.from(this.signature(signed), "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    try { return allowExpired || JSON.parse(Buffer.from(parts[1]!, "base64url").toString()).exp > Date.now() / 1000; }
    catch { return false; }
  }
  accepts(token: string | undefined) { return this.authentic(token); }
  async refresh(token: string, signal: AbortSignal) {
    if (!this.active || token !== this.refreshToken && !this.authentic(token, true)) throw new ProtocolError("unauthenticated", "Run impact cursor again to reconnect your account.");
    const usage = readUsage(await impactJson(this.connection, "/v1/usage", signal));
    if (usage.account.id !== this.id) { this.close(); throw new ProtocolError("unauthenticated", "Impact account changed. Relaunch Cursor."); }
    this.token = this.issue();
    return { access_token: this.token, refresh_token: this.refreshToken, token_type: "Bearer", expires_in: 90 * 86400 };
  }
  close() { this.active = false; this.secret.fill(0); }
}

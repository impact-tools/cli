import { Effect, Layer, Redacted } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import type { Connection } from "../../src/config/Connection.ts";

export const key = `sk-imp-${"A".repeat(43)}`;
export const connection: Connection = { baseUrl: "https://impact.test", apiKey: Redacted.make(key) };

export const usage = {
  currency: "USD",
  account: { id: "ada", email: "ada@example.com" },
  credits: { balance: "12.345", reserved: "2.5", total: "14.845" },
};

/** One body serves both catalogs: Claude reads `data`, Codex reads `models`. */
export const catalog = {
  data: [
    {
      id: "claude-sonnet-5-5",
      display_name: "Sonnet 5.5",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      context_length: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: ["tools", "vision"],
      reasoning_efforts: ["none", "low", "medium", "high", "max"],
      pricing: { input: 0.6, output: 3, cached_input: 0.06, cache_write: 0.75, unit: "usd_per_1m_tokens" },
    },
    {
      id: "gpt-6.1-sol",
      display_name: "GPT 6.1",
      max_input_tokens: 272_000,
      max_tokens: 128_000,
      context_length: 272_000,
      max_output_tokens: 128_000,
      capabilities: ["tools", "vision"],
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      pricing: { input: 0.3, output: 2.4, cached_input: 0.03, cache_write: 0, unit: "usd_per_1m_tokens" },
    },
  ],
  models: [{ slug: "gpt-6.1-sol", base_instructions: "Test instructions", additional_speed_tiers: ["fast"] }],
};

export const spend = {
  currency: "USD" as const,
  startAt: 1_700_000_000_000,
  asOf: 1_700_600_000_000,
  totalMicros: 3_125_000,
  models: [
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", chargedMicros: 2_000_000 },
    { id: "gpt-6.1-sol", name: "GPT 6.1", chargedMicros: 1_125_000 },
  ],
};

export const impactBody = (path: string) => {
  switch (path) {
    case "/v1/usage":
      return usage;
    case "/v1/usage/spend":
      return spend;
    case "/v1/models":
      return catalog;
    default:
      throw new Error(`Unexpected Impact fixture path: ${path}`);
  }
};

/** An in-memory Impact API; `respond` overrides the reply for a test. */
export const impactHttp = (
  respond: (url: URL, request: HttpClientRequest.HttpClientRequest) => Response = (url) =>
    Response.json(impactBody(url.pathname)),
) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, url) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond(url, request)))),
  );

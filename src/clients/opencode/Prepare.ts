import { Effect, Schema } from "effect";

import { CliError } from "../../Errors.ts";
import { clientEnvironment, type LaunchOptions } from "../Client.ts";
import { openCodeModels } from "./Models.ts";

const InlineSettings = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ provider: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);

/** Kilo is an OpenCode fork: both merge inline JSON settings from a variable over their config files. */
const prepareInline = (variable: "OPENCODE_CONFIG_CONTENT" | "KILO_CONFIG_CONTENT") =>
  Effect.fn("prepareInline")(function* ({ args, connection }: LaunchOptions) {
    const models = yield* openCodeModels(connection);
    const requested = process.env.IMPACT_MODEL?.replace(/^impact\//, "");
    const selected = requested ?? (models["gpt-6.1-sol"] ? "gpt-6.1-sol" : Object.keys(models)[0]!);
    if (!Object.hasOwn(models, selected))
      return yield* new CliError({ message: `Model ${requested} is unavailable in Impact.` });
    const saved = yield* Schema.decodeEffect(InlineSettings)(process.env[variable] ?? "{}").pipe(
      Effect.mapError(() => new CliError({ message: `${variable} must be a JSON settings object.` })),
    );
    const settings = {
      ...saved,
      model: `impact/${selected}`,
      small_model: `impact/${models["gpt-5.6-luna"] ? "gpt-5.6-luna" : selected}`,
      enabled_providers: ["impact"],
      disabled_providers: [],
      provider: {
        ...saved.provider,
        impact: {
          name: "Impact",
          npm: "@ai-sdk/openai-compatible",
          env: ["IMPACT_API_KEY"],
          options: { baseURL: `${connection.baseUrl}/v1`, apiKey: "{env:IMPACT_API_KEY}" },
          whitelist: Object.keys(models),
          blacklist: [],
          models,
        },
      },
    };
    const env: NodeJS.ProcessEnv = { ...clientEnvironment(connection), [variable]: JSON.stringify(settings) };
    return { args, env };
  });

export const prepareOpenCode = prepareInline("OPENCODE_CONFIG_CONTENT");
export const prepareKilo = prepareInline("KILO_CONFIG_CONTENT");

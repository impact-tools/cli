import { Effect, Schema } from "effect";

import { enabledMcpServers } from "../../config/Mcp.ts";
import { CliError } from "../../Errors.ts";
import { openCodeMcp } from "../../setup/Mcp.ts";
import { defaultModel } from "../../setup/Models.ts";
import { openCodeProvider, openCodeSmallModel } from "../../setup/OpenCode.ts";
import { clientEnvironment, type LaunchOptions } from "../Client.ts";
import { impactModels } from "./Models.ts";

const InlineSettings = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      provider: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      mcp: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);

/** Kilo is an OpenCode fork: both merge inline JSON settings from a variable over their config files. */
const prepareInline = (variable: "OPENCODE_CONFIG_CONTENT" | "KILO_CONFIG_CONTENT") =>
  Effect.fn("prepareInline")(function* ({ args, connection }: LaunchOptions) {
    const models = yield* impactModels(connection);
    const requested = process.env.IMPACT_MODEL?.replace(/^impact\//, "");
    const selected = requested ?? defaultModel(models)!.id;
    if (!models.some((model) => model.id === selected))
      return yield* new CliError({ message: `Model ${requested} is unavailable in Impact.` });
    const saved = yield* Schema.decodeEffect(InlineSettings)(process.env[variable] ?? "{}").pipe(
      Effect.mapError(() => new CliError({ message: `${variable} must be a JSON settings object.` })),
    );
    const servers = yield* enabledMcpServers;
    const settings = {
      ...saved,
      ...(servers.length === 0 ? {} : { mcp: { ...saved.mcp, ...openCodeMcp(servers, connection.baseUrl) } }),
      model: `impact/${selected}`,
      small_model: `impact/${openCodeSmallModel(models, selected)}`,
      enabled_providers: ["impact"],
      disabled_providers: [],
      provider: {
        ...saved.provider,
        impact: {
          ...openCodeProvider(models, `${connection.baseUrl}/v1`),
          whitelist: models.map((model) => model.id),
          blacklist: [],
        },
      },
    };
    const env: NodeJS.ProcessEnv = { ...clientEnvironment(connection), [variable]: JSON.stringify(settings) };
    return { args, env };
  });

export const prepareOpenCode = prepareInline("OPENCODE_CONFIG_CONTENT");
export const prepareKilo = prepareInline("KILO_CONFIG_CONTENT");

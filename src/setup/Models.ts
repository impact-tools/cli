/**
 * Models as a setup describes them. The launcher reads them from `GET /v1/models`; the docs' setup
 * page has the same catalog. Nothing in this folder touches files, the network or the process, so
 * the web app runs it in the browser too.
 */
export interface SetupModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** `tools`, `vision`, `reasoning`, … as `GET /v1/models` lists them. */
  readonly capabilities: readonly string[];
  /** The reasoning efforts the model accepts, `none` included when it can skip reasoning. */
  readonly efforts: readonly string[];
  /** USD per million tokens. */
  readonly pricing?: SetupPricing | undefined;
}

export interface SetupPricing {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
}

/** A row of the OpenAI-shaped `GET /v1/models` list, as far as a setup reads it. */
export interface ModelListRow {
  readonly id: string;
  readonly display_name?: string | undefined;
  readonly context_length: number;
  readonly max_output_tokens: number;
  readonly capabilities: readonly string[];
  readonly reasoning_efforts: readonly string[];
  readonly pricing: {
    readonly input: number;
    readonly output: number;
    readonly cached_input: number;
    readonly cache_write: number;
  };
}

export const fromModelList = (rows: readonly ModelListRow[]): SetupModel[] =>
  rows.map((row) => ({
    id: row.id,
    name: row.display_name ?? row.id,
    contextTokens: row.context_length,
    maxOutputTokens: row.max_output_tokens,
    capabilities: row.capabilities,
    efforts: row.reasoning_efforts,
    pricing: {
      input: row.pricing.input,
      output: row.pricing.output,
      cachedInput: row.pricing.cached_input,
      cacheWrite: row.pricing.cache_write,
    },
  }));

/** The model a launch starts on when nobody names one, if Impact offers it. */
export const DEFAULT_MODEL = "gpt-6.1-sol";

/** The fast model a client may use for titles and summaries, if Impact offers it. */
export const SMALL_MODEL = "gpt-5.6-luna";

/** `preferred` when it is listed, else the first model. */
export const defaultModel = <Model extends Pick<SetupModel, "id">>(
  models: readonly Model[],
  preferred = DEFAULT_MODEL,
): Model | undefined => models.find((model) => model.id === preferred) ?? models[0];

export const hasVision = (model: Pick<SetupModel, "capabilities">) => model.capabilities.includes("vision");

export const hasTools = (model: Pick<SetupModel, "capabilities">) => model.capabilities.includes("tools");

export const reasons = (model: Pick<SetupModel, "efforts">) => model.efforts.some((effort) => effort !== "none");

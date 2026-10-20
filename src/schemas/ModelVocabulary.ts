/**
 * The model catalog's vocabulary without its data: the reasoning efforts, the web search defaults and
 * the spellings a Claude model answers to. The CLI copies this file but not the catalog, because it
 * learns the models themselves, prices included, from `GET /v1/models`; nothing here changes when a
 * model is added or repriced.
 */

/** Reasoning efforts, lowest first; the same ladder the gateway's canonical request uses. */
export const MODEL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** The model that answers the gateway's `web_search` unless the key names another; searches are priced at it. */
export const SEARCH_MODEL_ID = "gemini-3.8-flash";

/** How hard the search model thinks: the Gemini 3 thinking levels, lowest first. */
export const SEARCH_EFFORTS = ["low", "medium", "high"] as const;
export type SearchEffort = (typeof SEARCH_EFFORTS)[number];

export const DEFAULT_SEARCH_EFFORT: SearchEffort = "high";

const claudeSpellings = (id: string): readonly string[] => {
  const dotted = id.replace(/(\d+)-(\d+)(?=-\d{8}$|$)/, "$1.$2");
  return [id, dotted, id.slice(7), dotted.slice(7)];
};

/**
 * Public Claude spellings; context suffixes never change the upstream model ID. A model pinned to a
 * dated snapshot (`wireModel` is its id plus `-YYYYMMDD`) also accepts the snapshot's spellings.
 */
export const claudeAliases = (model: {
  readonly id: string;
  readonly contextTokens: number;
  readonly wireModel?: string | undefined;
}): readonly string[] => {
  if (!/^claude-(?:opus|sonnet|haiku|fable)-/.test(model.id)) return [];
  const snapshot = model.wireModel;
  const pinned =
    snapshot !== undefined && /^-\d{8}$/.test(snapshot.slice(model.id.length)) && snapshot.startsWith(model.id);
  const names = [...new Set([model.id, ...(pinned ? [snapshot] : [])].flatMap(claudeSpellings))];
  return [
    ...names.filter((id) => id !== model.id),
    ...(model.contextTokens >= 1_000_000 ? names.map((id) => `${id}[1m]`) : []),
  ];
};

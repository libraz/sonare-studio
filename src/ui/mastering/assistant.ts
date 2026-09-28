/**
 * Parsing for the libsonare mastering assistant (`masteringAssistantSuggest`),
 * which analyzes a mix and returns a JSON string. Pure data module: it turns
 * that string into a typed suggestion. The wasm call, the audio render and
 * the (undoable) preset apply live in the panel.
 *
 * The assistant starts from the named preset supplied by the caller (the
 * runtime defaults to `streaming`) and returns that chain tuned to the mix.
 * Its flat `chainConfig.params` contains the complete tuned chain; the keys
 * where it differs from the selected preset become the project's overrides.
 */

/** Numeric audio profile measured by the assistant. */
export interface MasteringProfile {
  durationSec: number;
  bpm: number;
  bpmConfidence: number;
  integratedLufs: number;
  lraLu: number;
  truePeakDb: number;
  crestFactorDb: number;
  spectralCentroidHz: number;
  spectralFlatness: number;
  attackDensity: number;
  sustainRatio: number;
}

/** A parsed mastering-assistant suggestion. */
export interface MasteringSuggestion {
  /** Human-readable reasoning lines from the assistant (may be empty). */
  explanation: string[];
  /** Measured audio profile, or null when the assistant omitted it. */
  profile: MasteringProfile | null;
  /** Flat chain params tuned from the named base preset, or null when omitted. */
  chainParams: Record<string, number | boolean> | null;
}

/** Profile fields in the order they appear in the assistant JSON. */
const PROFILE_KEYS: ReadonlyArray<keyof MasteringProfile> = [
  'durationSec',
  'bpm',
  'bpmConfidence',
  'integratedLufs',
  'lraLu',
  'truePeakDb',
  'crestFactorDb',
  'spectralCentroidHz',
  'spectralFlatness',
  'attackDensity',
  'sustainRatio',
];

/** Reads a finite number from an unknown record field (0 when absent/invalid). */
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptySuggestion(): MasteringSuggestion {
  return { explanation: [], profile: null, chainParams: null };
}

/**
 * Parses the assistant's JSON string into a typed suggestion. Malformed input,
 * missing fields and wrong types are tolerated: a non-object or unparseable
 * string yields an empty suggestion rather than throwing.
 *
 * @param json The raw string returned by `masteringAssistantSuggest`.
 * @returns The parsed suggestion (empty explanation, null profile and chain
 *   params on any problem).
 */
export function parseMasteringSuggestion(json: string): MasteringSuggestion {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return emptySuggestion();
  }
  if (typeof root !== 'object' || root === null) {
    return emptySuggestion();
  }
  const record = root as Record<string, unknown>;

  const explanation: string[] = Array.isArray(record.explanation)
    ? record.explanation.filter((line): line is string => typeof line === 'string')
    : [];

  let profile: MasteringProfile | null = null;
  if (typeof record.profile === 'object' && record.profile !== null) {
    const source = record.profile as Record<string, unknown>;
    profile = {} as MasteringProfile;
    for (const key of PROFILE_KEYS) profile[key] = numberField(source, key);
  }

  let chainParams: Record<string, number | boolean> | null = null;
  const chainConfig = record.chainConfig as Record<string, unknown> | null | undefined;
  if (typeof chainConfig?.params === 'object' && chainConfig.params !== null) {
    chainParams = {};
    for (const [key, value] of Object.entries(chainConfig.params)) {
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        chainParams[key] = value;
      }
    }
  }

  return { explanation, profile, chainParams };
}

/**
 * The keys where a suggested chain differs from the preset it was tuned from,
 * with the suggested values: what to store as that preset's overrides.
 * Numbers within float rounding of the preset's value count as equal.
 *
 * @param chainParams The suggestion's flat chain params.
 * @param presetParams The preset's own flat params (masteringPresetParams).
 */
export function suggestedPresetOverrides(
  chainParams: Readonly<Record<string, number | boolean>>,
  presetParams: Readonly<Record<string, number | boolean>>,
): Record<string, number | boolean> {
  const overrides: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(chainParams)) {
    const base = presetParams[key];
    const same =
      typeof value === 'number' && typeof base === 'number'
        ? Math.abs(value - base) <= 1e-6 * Math.max(1, Math.abs(base))
        : value === base;
    if (!same) overrides[key] = value;
  }
  return overrides;
}

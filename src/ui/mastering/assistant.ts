/**
 * Parsing for the libsonare mastering assistant (`masteringAssistantSuggest`),
 * which analyzes a mix and returns a JSON string. Pure data module: it turns
 * that string into a typed suggestion and picks the preset to apply. The wasm
 * call, the audio render and the (undoable) preset apply live in the panel.
 *
 * The assistant's `genreCandidates[].name` values are the camelCase preset
 * identifiers (pop, edm, jpop, …), so the top candidate maps directly onto the
 * project's mastering preset selector. Its flat `chainConfig.params` is that
 * preset's chain tuned to the mix; the keys where it differs from the preset
 * become the chain's preset overrides.
 */

/** One scored genre/preset candidate from the assistant. */
export interface MasteringGenreCandidate {
  /** camelCase preset identifier (e.g. 'pop', 'jpop'). */
  name: string;
  /** Match score (higher = stronger); candidates arrive best-first. */
  score: number;
}

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
  /** Scored preset candidates, best first (may be empty). */
  genreCandidates: MasteringGenreCandidate[];
  /** Human-readable reasoning lines from the assistant (may be empty). */
  explanation: string[];
  /** Measured audio profile, or null when the assistant omitted it. */
  profile: MasteringProfile | null;
  /** Flat chain params tuned for the top candidate, or null when omitted. */
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

/**
 * Parses the assistant's JSON string into a typed suggestion. Malformed input,
 * missing fields and wrong types are tolerated: a non-object or unparseable
 * string yields an empty suggestion rather than throwing.
 *
 * @param json The raw string returned by `masteringAssistantSuggest`.
 * @returns The parsed suggestion (empty candidates/explanation, null profile,
 *   on any problem).
 */
export function parseMasteringSuggestion(json: string): MasteringSuggestion {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return { genreCandidates: [], explanation: [], profile: null, chainParams: null };
  }
  if (typeof root !== 'object' || root === null) {
    return { genreCandidates: [], explanation: [], profile: null, chainParams: null };
  }
  const record = root as Record<string, unknown>;

  const genreCandidates: MasteringGenreCandidate[] = [];
  if (Array.isArray(record.genreCandidates)) {
    for (const entry of record.genreCandidates) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || candidate.name.length === 0) continue;
      genreCandidates.push({ name: candidate.name, score: numberField(candidate, 'score') });
    }
  }

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

  return { genreCandidates, explanation, profile, chainParams };
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

/**
 * Picks the preset to apply from a suggestion: the best candidate the project
 * actually offers, falling back to the best candidate overall (still a valid
 * preset id) and then to null when there are no candidates.
 *
 * @param suggestion A parsed suggestion.
 * @param available Preset identifiers the project's catalog supports.
 * @returns The preset name to apply, or null.
 */
export function suggestedPreset(
  suggestion: MasteringSuggestion,
  available: ReadonlyArray<string>,
): string | null {
  const candidates = suggestion.genreCandidates;
  if (candidates.length === 0) return null;
  const offered = new Set(available);
  const match = candidates.find((candidate) => offered.has(candidate.name));
  return (match ?? candidates[0]).name;
}

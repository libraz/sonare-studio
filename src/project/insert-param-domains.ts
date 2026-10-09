/**
 * Display windows for insert parameters the library descriptor cannot
 * describe. `masteringInsertParamInfo` publishes uiMin/uiMax, bounds, unit and
 * axis for nearly every key, and `processorNumberSpec` reads those first; an
 * entry here survives only where the descriptor leaves an end open.
 */

/** Drawing/editing value range and unit of one insert parameter. */
export interface InsertParamDomain {
  /** Value mapped to the sublane bottom. */
  min: number;
  /** Value mapped to the sublane top. */
  max: number;
  /** Display unit (e.g. 'dB', 'ms', ''); informational only. */
  unit: string;
}

/** Neutral fallback domain used when a parameter is not catalogued. */
export const INSERT_PARAM_DOMAIN_FALLBACK: InsertParamDomain = { min: 0, max: 1, unit: '' };

/** One app-side display-domain key, exposed for runtime-catalog contract checks. */
export interface InsertParamDomainEntry {
  processor: string;
  paramName: string;
}

/**
 * Per-(processor, parameter) display domains. Keyed by the processor catalog
 * name, then by the parameter's JSON-key name (see `masteringInsertParamInfo`).
 */
const INSERT_PARAM_DOMAINS: Record<string, Record<string, InsertParamDomain>> = {
  // Bounded below (exclusive 0) but open above, with no uiMax.
  'saturation.softClipper': {
    ceiling: { min: 0, max: 1, unit: '' },
  },
};

/** Lists every display-domain key for comparison with the engine parameter catalog. */
export function insertParamDomainEntries(): InsertParamDomainEntry[] {
  return Object.entries(INSERT_PARAM_DOMAINS).flatMap(([processor, params]) =>
    Object.keys(params).map((paramName) => ({ processor, paramName })),
  );
}

/**
 * Resolves the display domain of an insert parameter, falling back to a
 * neutral [0, 1] window when the parameter is not catalogued.
 *
 * @param processor Processor catalog name (e.g. 'dynamics.compressor').
 * @param paramName Parameter JSON-key name (e.g. 'thresholdDb').
 * @returns The display domain, or {@link INSERT_PARAM_DOMAIN_FALLBACK}.
 */
export function insertParamDomain(processor: string, paramName: string): InsertParamDomain {
  return INSERT_PARAM_DOMAINS[processor]?.[paramName] ?? INSERT_PARAM_DOMAIN_FALLBACK;
}

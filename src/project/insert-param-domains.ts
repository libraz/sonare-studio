/**
 * Display-only value domains for insert-parameter automation. The wasm
 * `masteringInsertParamInfo` catalog reports each realtime-automatable
 * parameter's name/id but not its value range, so the automation sublane needs
 * a small app-side catalog to scale insert lanes. Entries cover the most
 * commonly automated processors; anything absent falls back to a neutral [0, 1]
 * window, which still lets the lane be drawn and edited.
 *
 * Ranges are display windows (the comfortable drawing range of a parameter),
 * not the engine's hard clamp bounds: values outside the window still record,
 * they just pin to the sublane edge. Parameter names are the processor's
 * JSON-key names (see the libsonare field tables / `masteringInsertParamInfo`).
 */

import { type AutomationParam, parseInsertAutomationParam } from './automation';
import type { MixerStrip } from './mixer';

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

/**
 * Per-(processor, parameter) display domains. Keyed by the processor catalog
 * name, then by the parameter's JSON-key name (see `masteringInsertParamInfo`).
 */
const INSERT_PARAM_DOMAINS: Record<string, Record<string, InsertParamDomain>> = {
  'dynamics.compressor': {
    thresholdDb: { min: -60, max: 0, unit: 'dB' },
    ratio: { min: 1, max: 20, unit: '' },
    attackMs: { min: 0, max: 200, unit: 'ms' },
    releaseMs: { min: 0, max: 2000, unit: 'ms' },
    kneeDb: { min: 0, max: 24, unit: 'dB' },
    makeupGainDb: { min: -12, max: 24, unit: 'dB' },
  },
  'dynamics.limiter': {
    thresholdDb: { min: -60, max: 0, unit: 'dB' },
    lookaheadMs: { min: 0, max: 20, unit: 'ms' },
    releaseMs: { min: 0, max: 1000, unit: 'ms' },
  },
  'dynamics.brickwallLimiter': {
    ceilingDb: { min: -24, max: 0, unit: 'dB' },
    lookaheadMs: { min: 0, max: 20, unit: 'ms' },
    releaseMs: { min: 0, max: 1000, unit: 'ms' },
  },
  'dynamics.gate': {
    thresholdDb: { min: -80, max: 0, unit: 'dB' },
    attackMs: { min: 0, max: 100, unit: 'ms' },
    releaseMs: { min: 0, max: 2000, unit: 'ms' },
    rangeDb: { min: -80, max: 0, unit: 'dB' },
    holdMs: { min: 0, max: 1000, unit: 'ms' },
  },
  'dynamics.deesser': {
    frequencyHz: { min: 1000, max: 16000, unit: 'Hz' },
    thresholdDb: { min: -60, max: 0, unit: 'dB' },
    ratio: { min: 1, max: 20, unit: '' },
  },
  'eq.tilt': {
    tiltDb: { min: -12, max: 12, unit: 'dB' },
    pivotHz: { min: 20, max: 20000, unit: 'Hz' },
  },
  'saturation.tape': {
    driveDb: { min: -12, max: 24, unit: 'dB' },
    saturation: { min: 0, max: 1, unit: '' },
    outputGainDb: { min: -24, max: 24, unit: 'dB' },
  },
  'saturation.softClipper': {
    driveDb: { min: -12, max: 24, unit: 'dB' },
    ceiling: { min: 0, max: 1, unit: '' },
    mix: { min: 0, max: 1, unit: '' },
  },
  'saturation.waveshaper': {
    driveDb: { min: -12, max: 24, unit: 'dB' },
    mix: { min: 0, max: 1, unit: '' },
    outputGainDb: { min: -24, max: 24, unit: 'dB' },
  },
  'stereo.imager': {
    width: { min: 0, max: 2, unit: '' },
    decorrelationAmount: { min: 0, max: 1, unit: '' },
    outputGainDb: { min: -24, max: 24, unit: 'dB' },
  },
  'stereo.monoMaker': {
    amount: { min: 0, max: 1, unit: '' },
  },
  'maximizer.maximizer': {
    inputGainDb: { min: 0, max: 24, unit: 'dB' },
    ceilingDb: { min: -24, max: 0, unit: 'dB' },
    releaseMs: { min: 0, max: 1000, unit: 'ms' },
  },
};

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

/**
 * Resolves the display domain for the insert parameter a lane automates on a
 * strip: decodes the insert token, looks up the addressed slot's processor and
 * returns that parameter's catalogued domain.
 *
 * @param strip Strip the lane targets (its `inserts` carry the processor); the
 *   master/track/bus strip the lane lives on.
 * @param param Automated parameter token.
 * @returns The display domain, or undefined when `param` is not an insert
 *   token or the addressed slot is absent (the caller then uses its own
 *   neutral fallback).
 */
export function insertParamDomainForStrip(
  strip: Pick<MixerStrip, 'inserts'> | undefined,
  param: AutomationParam,
): InsertParamDomain | undefined {
  const ref = parseInsertAutomationParam(param);
  if (!ref) return undefined;
  const slot = strip?.inserts[ref.insertIndex];
  if (!slot) return undefined;
  return insertParamDomain(slot.processor, ref.paramName);
}

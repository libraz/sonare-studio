/**
 * Mapping for the libsonare mastering assistant (`masteringAssistantSuggest`),
 * which analyzes a mix and returns a typed `MasteringAssistantResult`.
 * Pure data module: the wasm call, the audio render and the (undoable) preset
 * apply live in the panel.
 *
 * The assistant starts from the named preset supplied by the caller and
 * returns that chain tuned to the mix as a complete nested config; the fields
 * where it differs from the selected preset become the project's overrides.
 */

import type { MasteringChainConfig } from '@libraz/libsonare';
import { flattenChainConfig, getChainPath, setChainValue } from './chain-config-path';

/** One field the suggestion tuned away from its base preset. */
export interface SuggestionAdjustment {
  /** Dotted path inside the chain config. */
  key: string;
  /** The preset's value, absent when the preset leaves the field unset. */
  from: unknown;
  to: unknown;
}

const sameValue = (value: unknown, base: unknown): boolean => {
  if (typeof value === 'number' && typeof base === 'number') {
    return Math.abs(value - base) <= 1e-6 * Math.max(1, Math.abs(base));
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value) === JSON.stringify(base);
  }
  return value === base;
};

/**
 * The fields where a suggested chain differs from the preset it was tuned
 * from, with the suggested values. Numbers within float rounding of the
 * preset's value count as equal.
 *
 * @param chainConfig The suggestion's complete chain config.
 * @param presetParams The preset's own chain config (masteringPresetParams).
 */
export function suggestedAdjustments(
  chainConfig: MasteringChainConfig,
  presetParams: MasteringChainConfig,
): SuggestionAdjustment[] {
  return flattenChainConfig(chainConfig)
    .filter(({ path, value }) => !sameValue(value, getChainPath(presetParams, path)))
    .map(({ path, value }) => ({ key: path, from: getChainPath(presetParams, path), to: value }));
}

/**
 * The nested overrides to store for a suggestion: only the adjusted fields.
 *
 * @param chainConfig The suggestion's complete chain config.
 * @param presetParams The preset's own chain config (masteringPresetParams).
 */
export function suggestedPresetOverrides(
  chainConfig: MasteringChainConfig,
  presetParams: MasteringChainConfig,
): MasteringChainConfig {
  let overrides: MasteringChainConfig = {};
  for (const { key, to } of suggestedAdjustments(chainConfig, presetParams)) {
    overrides = setChainValue(overrides, key, to);
  }
  return overrides;
}

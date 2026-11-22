/**
 * The small, stable control surface for named mastering presets.
 *
 * Overrides are the core's nested `MasteringChainConfig`; each control names
 * one typed path inside it. The panel deliberately presents only the
 * parameters a mastering engineer can reasonably tune from a compact DAW
 * inspector. Keep this module free of Vue and wasm runtime imports so the
 * resolution and validation rules can be tested in isolation.
 */

import type { MasteringChainConfig } from '@libraz/libsonare';
import {
  type ChainPath,
  deleteChainPath,
  flattenChainConfig,
  getChainPath,
  setChainPath,
} from './chain-config-path';

export type PresetControlValue = number | boolean;

export type PresetControlSection = 'output' | 'restoration';

export type PresetControlKind = 'boolean' | 'number' | 'enum';

/** Control paths; each must stay a valid path of the core's chain config. */
export type PresetControlKey =
  | 'loudness.enabled'
  | 'loudness.targetLufs'
  | 'loudness.ceilingDbtp'
  | 'loudness.truePeakOversample'
  | 'loudness.releaseMs'
  | 'loudness.maxLimiterGainReductionDb'
  | 'repair.denoise.enabled'
  | 'repair.denoise.reductionDb';

export interface PresetControlDescriptor {
  key: PresetControlKey;
  section: PresetControlSection;
  kind: PresetControlKind;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly number[];
}

/** The typed override paths exposed in the mastering inspector. */
export const PRESET_CONTROL_DESCRIPTORS = [
  {
    key: 'loudness.enabled',
    section: 'output',
    kind: 'boolean',
  },
  {
    key: 'loudness.targetLufs',
    section: 'output',
    kind: 'number',
    step: 0.1,
  },
  {
    key: 'loudness.ceilingDbtp',
    section: 'output',
    kind: 'number',
    step: 0.1,
  },
  {
    key: 'loudness.truePeakOversample',
    section: 'output',
    kind: 'enum',
    options: [1, 2, 4, 8, 16],
  },
  {
    key: 'loudness.releaseMs',
    section: 'output',
    kind: 'number',
    min: 0,
    step: 1,
  },
  {
    key: 'loudness.maxLimiterGainReductionDb',
    section: 'output',
    kind: 'number',
    min: 0,
    step: 0.1,
  },
  {
    key: 'repair.denoise.enabled',
    section: 'restoration',
    kind: 'boolean',
  },
  {
    key: 'repair.denoise.reductionDb',
    section: 'restoration',
    kind: 'number',
    min: 0,
    max: 120,
    step: 0.1,
  },
] as const satisfies readonly PresetControlDescriptor[];

const FLOAT32_MAX = 3.4028234663852886e38;

const DEFAULT_PRESET_CONTROL_VALUES: Readonly<Record<PresetControlKey, PresetControlValue>> = {
  'loudness.enabled': true,
  'loudness.targetLufs': -14,
  'loudness.ceilingDbtp': -1,
  'loudness.truePeakOversample': 4,
  'loudness.releaseMs': 50,
  'loudness.maxLimiterGainReductionDb': 12,
  'repair.denoise.enabled': false,
  'repair.denoise.reductionDb': 26,
};

/** Returns the descriptor for a known control path. */
export function getPresetControlDescriptor(key: string): PresetControlDescriptor | undefined {
  return PRESET_CONTROL_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}

/** True for a path that has a typed inspector control. */
export function isKnownPresetOverrideKey(key: string): boolean {
  return getPresetControlDescriptor(key) !== undefined;
}

/** Reads a control's value from a config; undefined when it is absent. */
function readControl(
  config: MasteringChainConfig,
  key: PresetControlKey,
): PresetControlValue | undefined {
  const path: ChainPath & PresetControlKey = key;
  return getChainPath(config, path) as PresetControlValue | undefined;
}

/** Writes a control's value into a copy of a config. */
function writeControl(
  config: MasteringChainConfig,
  key: PresetControlKey,
  value: PresetControlValue,
): MasteringChainConfig {
  const path: ChainPath & PresetControlKey = key;
  return setChainPath(config, path, value as never);
}

/** True when the selected control currently has a saved override. */
export function hasPresetControlOverride(
  key: PresetControlKey,
  overrides: MasteringChainConfig = {},
): boolean {
  return readControl(overrides, key) !== undefined;
}

/** Returns the stage switch that controls a parameter-only override. */
export function presetControlEnabledKey(key: PresetControlKey): PresetControlKey | undefined {
  if (key === 'loudness.enabled' || key === 'repair.denoise.enabled') return undefined;
  if (key.startsWith('loudness.')) return 'loudness.enabled';
  if (key === 'repair.denoise.reductionDb') return 'repair.denoise.enabled';
  return undefined;
}

/** True when a path is a parameter of the stage a switch controls. */
function isStageParameterPath(enabledKey: PresetControlKey, path: string): boolean {
  if (path === enabledKey) return false;
  return path.startsWith(enabledKey.slice(0, -'enabled'.length));
}

function hasSiblingParameterOverride(
  descriptor: PresetControlDescriptor,
  enabledKey: PresetControlKey,
  overrides: MasteringChainConfig,
): boolean {
  return flattenChainConfig(overrides).some(
    ({ path }) => path !== descriptor.key && isStageParameterPath(enabledKey, path),
  );
}

/**
 * Builds the complete override config for one inspector edit. The core treats
 * a parameter-only stage override as an implicit enable, so the currently
 * displayed stage switch is stored alongside the edited value in one atomic
 * preset command.
 */
export function presetControlOverridesForEdit(
  descriptor: PresetControlDescriptor,
  value: PresetControlValue,
  presetParams: MasteringChainConfig = {},
  overrides: MasteringChainConfig = {},
): MasteringChainConfig {
  let next = writeControl(overrides, descriptor.key, value);
  const enabledKey = presetControlEnabledKey(descriptor.key);
  if (enabledKey) {
    const enabledDescriptor = getPresetControlDescriptor(enabledKey);
    if (enabledDescriptor) {
      next = writeControl(
        next,
        enabledKey,
        resolvePresetControlValue(enabledDescriptor, presetParams, overrides),
      );
    }
  }
  return next;
}

/**
 * Removes one typed override. If another parameter for the same stage remains,
 * retain an explicit stage switch so the core cannot implicitly turn a
 * disabled stage on. Other stage parameters count as siblings here too.
 */
export function presetControlOverridesForReset(
  descriptor: PresetControlDescriptor,
  presetParams: MasteringChainConfig = {},
  overrides: MasteringChainConfig = {},
): MasteringChainConfig {
  let next = deleteChainPath(overrides, descriptor.key);
  const enabledKey =
    descriptor.kind === 'boolean' && descriptor.key.endsWith('.enabled')
      ? descriptor.key
      : presetControlEnabledKey(descriptor.key);
  const hasSibling = enabledKey
    ? hasSiblingParameterOverride(descriptor, enabledKey, overrides)
    : false;
  if (enabledKey && hasSibling) {
    const enabledDescriptor = getPresetControlDescriptor(enabledKey);
    if (enabledDescriptor) {
      // Resetting the switch restores the preset state. Resetting a parameter
      // keeps the current switch state, including an explicit user toggle.
      next = writeControl(
        next,
        enabledKey,
        resolvePresetControlValue(
          enabledDescriptor,
          presetParams,
          descriptor.key === enabledKey ? {} : overrides,
        ),
      );
    }
  } else if (
    enabledKey &&
    hasPresetControlOverride(enabledKey, overrides) &&
    descriptor.key !== enabledKey
  ) {
    const enabledDescriptor = getPresetControlDescriptor(enabledKey);
    const presetValue = enabledDescriptor
      ? resolvePresetControlValue(enabledDescriptor, presetParams)
      : undefined;
    if (readControl(overrides, enabledKey) === presetValue) {
      next = deleteChainPath(next, enabledKey);
    }
  }
  return next;
}

/**
 * Resolves a control using the saved override first, then the runtime preset
 * config, and finally the library defaults.
 */
export function resolvePresetControlValue(
  descriptor: PresetControlDescriptor,
  presetParams: MasteringChainConfig = {},
  overrides: MasteringChainConfig = {},
): PresetControlValue {
  const override = readControl(overrides, descriptor.key);
  if (isValidPresetControlValue(descriptor, override)) return override;

  // A parameter-only override is an implicit stage enable in the core, so the
  // inspector must show the same effective switch value instead of the
  // preset's off state.
  if (
    descriptor.kind === 'boolean' &&
    descriptor.key.endsWith('.enabled') &&
    flattenChainConfig(overrides).some(({ path }) => isStageParameterPath(descriptor.key, path))
  ) {
    return true;
  }

  const presetValue = readControl(presetParams, descriptor.key);
  if (isValidPresetControlValue(descriptor, presetValue)) return presetValue;

  return DEFAULT_PRESET_CONTROL_VALUES[descriptor.key];
}

/** Returns whether a persisted or runtime value is valid for this control. */
export function isValidPresetControlValue(
  descriptor: PresetControlDescriptor,
  value: unknown,
): value is PresetControlValue {
  if (descriptor.kind === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (Math.abs(value) > FLOAT32_MAX) return false;
  if (descriptor.min !== undefined && value < descriptor.min) return false;
  if (descriptor.max !== undefined && value > descriptor.max) return false;
  if (descriptor.kind === 'enum' && !descriptor.options?.includes(value)) return false;
  return true;
}

/**
 * Parses a native input value and rejects empty, non-finite, out-of-range and
 * unsupported enum values before they reach the project command layer.
 */
export function parsePresetControlValue(
  descriptor: PresetControlDescriptor,
  input: unknown,
): PresetControlValue {
  if (descriptor.kind === 'boolean') {
    if (typeof input !== 'boolean') throw new RangeError(`${descriptor.key} must be boolean`);
    return input;
  }
  const text = typeof input === 'number' ? undefined : String(input).trim();
  if (text === '') throw new RangeError(`${descriptor.key} must not be empty`);
  const value = typeof input === 'number' ? input : Number(text);
  if (!isValidPresetControlValue(descriptor, value)) {
    throw new RangeError(`${descriptor.key} is outside its supported range`);
  }
  return value;
}

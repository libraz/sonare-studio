/**
 * The small, stable control surface for named mastering presets.
 *
 * libsonare exposes preset parameters as a flat map because that is useful at
 * the ABI boundary. The panel deliberately presents only the parameters a
 * mastering engineer can reasonably tune from a compact DAW inspector. Keep
 * this module free of Vue and wasm imports so the resolution and validation
 * rules can be tested in isolation.
 */

export type PresetControlValue = number | boolean;

export type PresetControlSection = 'output' | 'restoration';

export type PresetControlKind = 'boolean' | 'number' | 'enum';

export type PresetControlKey =
  | 'loudness.enabled'
  | 'loudness.targetLufs'
  | 'loudness.ceilingDb'
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

export const LEGACY_DENOISE_OVERRIDE_KEY = 'repair.reductionDb';

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
    key: 'loudness.ceilingDb',
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

export const PRESET_CONTROL_KEYS: readonly PresetControlKey[] = PRESET_CONTROL_DESCRIPTORS.map(
  ({ key }) => key,
);

const FLOAT32_MAX = 3.4028234663852886e38;
const LEGACY_DENOISE_PARAMETER_KEYS = new Set([
  'repair.nFft',
  'repair.hopLength',
  'repair.ddAlpha',
  LEGACY_DENOISE_OVERRIDE_KEY,
  'repair.gainFloor',
]);

const DEFAULT_PRESET_CONTROL_VALUES: Readonly<Record<PresetControlKey, PresetControlValue>> = {
  'loudness.enabled': true,
  'loudness.targetLufs': -14,
  'loudness.ceilingDb': -1,
  'loudness.truePeakOversample': 4,
  'loudness.releaseMs': 50,
  'loudness.maxLimiterGainReductionDb': 12,
  'repair.denoise.enabled': false,
  'repair.denoise.reductionDb': 26,
};

const hasOwn = (values: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.hasOwn(values, key);

/** Returns the descriptor for a known control path. */
export function getPresetControlDescriptor(key: string): PresetControlDescriptor | undefined {
  return PRESET_CONTROL_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}

/** True for known controls, including the legacy denoise alias. */
export function isKnownPresetOverrideKey(key: string): boolean {
  return getPresetControlDescriptor(key) !== undefined || key === LEGACY_DENOISE_OVERRIDE_KEY;
}

/**
 * Returns the persisted key to update for a control. Existing projects that
 * used the old denoise alias keep using that one, which prevents a single edit
 * from writing both aliases. New edits use the canonical nested path.
 */
export function presetControlOverrideKey(
  key: PresetControlKey,
  overrides: Readonly<Record<string, PresetControlValue>> = {},
): PresetControlKey | typeof LEGACY_DENOISE_OVERRIDE_KEY {
  if (hasOwn(overrides, key)) return key;
  if (key === 'repair.denoise.reductionDb' && hasOwn(overrides, LEGACY_DENOISE_OVERRIDE_KEY)) {
    return LEGACY_DENOISE_OVERRIDE_KEY;
  }
  return key;
}

/** True when the selected control currently has a saved override. */
export function hasPresetControlOverride(
  key: PresetControlKey,
  overrides: Readonly<Record<string, PresetControlValue>> = {},
): boolean {
  return (
    hasOwn(overrides, key) ||
    (key === 'repair.denoise.reductionDb' && hasOwn(overrides, LEGACY_DENOISE_OVERRIDE_KEY))
  );
}

/** Returns the stage switch that controls a parameter-only override. */
export function presetControlEnabledKey(key: PresetControlKey): PresetControlKey | undefined {
  if (key === 'loudness.enabled' || key === 'repair.denoise.enabled') return undefined;
  if (key.startsWith('loudness.')) return 'loudness.enabled';
  if (key === 'repair.denoise.reductionDb') return 'repair.denoise.enabled';
  return undefined;
}

function isStageParameterOverrideKey(enabledKey: PresetControlKey, key: string): boolean {
  if (key === enabledKey) return false;
  if (enabledKey === 'loudness.enabled') return key.startsWith('loudness.');
  if (enabledKey === 'repair.denoise.enabled') {
    return key.startsWith('repair.denoise.') || LEGACY_DENOISE_PARAMETER_KEYS.has(key);
  }
  return false;
}

function isDescriptorOverrideKey(descriptor: PresetControlDescriptor, key: string): boolean {
  return (
    key === descriptor.key ||
    (descriptor.key === 'repair.denoise.reductionDb' && key === LEGACY_DENOISE_OVERRIDE_KEY)
  );
}

function hasSiblingParameterOverride(
  descriptor: PresetControlDescriptor,
  enabledKey: PresetControlKey,
  overrides: Readonly<Record<string, PresetControlValue>>,
): boolean {
  return Object.keys(overrides).some(
    (key) =>
      !isDescriptorOverrideKey(descriptor, key) && isStageParameterOverrideKey(enabledKey, key),
  );
}

/**
 * Builds the complete flat override bag for one inspector edit. libsonare's
 * chain parser treats a parameter-only stage override as an implicit enable,
 * so the currently displayed stage switch is persisted alongside the edited
 * value in one atomic preset command.
 */
export function presetControlOverridesForEdit(
  descriptor: PresetControlDescriptor,
  value: PresetControlValue,
  presetParams: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, PresetControlValue>> = {},
): Record<string, PresetControlValue> {
  const next = { ...overrides };
  next[descriptor.key] = value;
  if (descriptor.key === 'repair.denoise.reductionDb') {
    delete next[LEGACY_DENOISE_OVERRIDE_KEY];
  }
  const enabledKey = presetControlEnabledKey(descriptor.key);
  if (enabledKey) {
    const enabledDescriptor = getPresetControlDescriptor(enabledKey);
    if (enabledDescriptor) {
      next[enabledKey] = resolvePresetControlValue(enabledDescriptor, presetParams, overrides);
    }
  }
  return next;
}

/**
 * Removes one typed override. If another parameter for the same stage remains,
 * retain an explicit stage switch so libsonare cannot implicitly turn a
 * disabled stage on. Unknown Advanced keys count as parameters here too.
 */
export function presetControlOverridesForReset(
  descriptor: PresetControlDescriptor,
  presetParams: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, PresetControlValue>> = {},
): Record<string, PresetControlValue> {
  const next = { ...overrides };
  delete next[descriptor.key];
  if (descriptor.key === 'repair.denoise.reductionDb') {
    delete next[LEGACY_DENOISE_OVERRIDE_KEY];
  }
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
      next[enabledKey] = resolvePresetControlValue(
        enabledDescriptor,
        presetParams,
        descriptor.key === enabledKey ? {} : overrides,
      );
    }
  } else if (enabledKey && hasOwn(overrides, enabledKey) && descriptor.key !== enabledKey) {
    const enabledDescriptor = getPresetControlDescriptor(enabledKey);
    const presetValue = enabledDescriptor
      ? resolvePresetControlValue(enabledDescriptor, presetParams)
      : undefined;
    if (overrides[enabledKey] === presetValue) delete next[enabledKey];
  }
  return next;
}

/**
 * Resolves a control using the saved override first, then the runtime preset
 * parameters, and finally the library defaults. The legacy denoise alias is
 * accepted on both sides of the ABI boundary for old project files.
 */
export function resolvePresetControlValue(
  descriptor: PresetControlDescriptor,
  presetParams: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, PresetControlValue>> = {},
): PresetControlValue {
  const overrideKey = presetControlOverrideKey(descriptor.key, overrides);
  const override = overrides[overrideKey];
  if (isValidPresetControlValue(descriptor, override)) return override;

  // Older project files can contain parameter-only overrides. The core treats
  // those as an implicit stage enable, so the inspector must show the same
  // effective switch value instead of displaying the preset's off state.
  if (
    descriptor.kind === 'boolean' &&
    descriptor.key.endsWith('.enabled') &&
    Object.keys(overrides).some((key) => isStageParameterOverrideKey(descriptor.key, key))
  ) {
    return true;
  }

  const presetValue = presetParams[descriptor.key];
  if (isValidPresetControlValue(descriptor, presetValue)) return presetValue;
  if (descriptor.key === 'repair.denoise.reductionDb') {
    const legacyPresetValue = presetParams[LEGACY_DENOISE_OVERRIDE_KEY];
    if (isValidPresetControlValue(descriptor, legacyPresetValue)) return legacyPresetValue;
  }

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

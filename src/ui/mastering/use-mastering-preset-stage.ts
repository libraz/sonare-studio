/**
 * Preset stage of the mastering panel: the preset picker menu, and the typed
 * and advanced overrides layered over the selected preset.
 */

import type { MasteringChainConfig, MasteringPreset } from '@libraz/libsonare';
import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { applyMasteringPresetWithOverrides, setMasteringPreset } from '@/project/commands';
import type { MasteringChainState } from '@/project/mixer';
import { getWasmModule } from '@/project/runtime';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { deleteChainPath, flattenChainConfig } from '@/ui/mastering/chain-config-path';
import {
  filterPresetCatalog,
  humanizePresetName,
  loadMasteringPresetCatalog,
} from '@/ui/mastering/preset-catalog';
import {
  getPresetControlDescriptor,
  hasPresetControlOverride,
  isKnownPresetOverrideKey,
  PRESET_CONTROL_DESCRIPTORS,
  type PresetControlDescriptor,
  type PresetControlKey,
  type PresetControlSection,
  type PresetControlValue,
  parsePresetControlValue,
  presetControlEnabledKey,
  presetControlOverridesForEdit,
  presetControlOverridesForReset,
  resolvePresetControlValue,
} from '@/ui/mastering/preset-controls';

/** Configuration for {@link useMasteringPresetStage}. */
export interface UseMasteringPresetStageOptions {
  /** The project mastering chain, or the default chain when none is stored. */
  chain: ComputedRef<MasteringChainState>;
  /** The panel's error banner. */
  error: Ref<string>;
  /** Runs an undoable edit, clearing the banner or setting it on a throw. */
  runCommand(action: () => void): void;
}

/** Preset menu and override state returned by {@link useMasteringPresetStage}. */
export interface MasteringPresetStage {
  /** True while the preset picker menu is open. */
  presetMenuOpen: Ref<boolean>;
  /** Filter text typed into the preset picker. */
  presetQuery: Ref<string>;
  /** Catalog presets matching the filter text. */
  filteredPresets: ComputedRef<string[]>;
  /** Display name of the selected preset, or the no-preset label. */
  presetLabel: ComputedRef<string>;
  /** Opens the picker (reloading the catalog) or closes it. */
  togglePresetMenu(): void;
  /** Selects a preset by catalog name, or clears it with null. */
  onSelectPreset(preset: string | null): void;
  /** Inspector sections, in display order. */
  PRESET_SECTIONS: readonly PresetControlSection[];
  /** Typed controls grouped by inspector section. */
  presetControlSections: ComputedRef<Record<PresetControlSection, PresetControlDescriptor[]>>;
  /** Override fields without a typed control, as sorted path/value pairs. */
  presetOverrideEntries: ComputedRef<(readonly [string, unknown])[]>;
  /** Formats an untyped override value for display. */
  formatOverrideValue(value: unknown): string;
  /** Effective value of a typed control: its override, else the preset's. */
  presetControlValue(descriptor: PresetControlDescriptor): PresetControlValue;
  /** Localized label of a typed control. */
  presetControlLabel(key: PresetControlKey): string;
  /** Localized hint of a typed control. */
  presetControlHint(key: PresetControlKey): string;
  /** Why every preset control is unavailable, or null. */
  presetBlocked: ComputedRef<string | null>;
  /** Why each typed control is unavailable, or null. */
  presetControlBlocked: ComputedRef<Record<PresetControlKey, string | null>>;
  /** Unit label shown after a typed control. */
  presetControlUnit(descriptor: PresetControlDescriptor): string;
  /** Lower bound of a numeric control. */
  presetControlMin(descriptor: PresetControlDescriptor): number | undefined;
  /** Upper bound of a numeric control. */
  presetControlMax(descriptor: PresetControlDescriptor): number | undefined;
  /** Step of a numeric control. */
  presetControlStep(descriptor: PresetControlDescriptor): number | undefined;
  /** Applies a typed control's input or change event as an override. */
  onPresetControlInput(key: string, event: Event): void;
  /** Drops a typed control's override, restoring the preset value. */
  onResetPresetControl(key: PresetControlKey): void;
  /** Drops an untyped override field. */
  onClearPresetOverride(key: string): void;
}

/**
 * Creates the preset picker and override editor of the mastering panel.
 *
 * @param options - The mastering chain, error banner and command runner.
 * @returns Menu state, override controls and their actions.
 */
export function useMasteringPresetStage(
  options: UseMasteringPresetStageOptions,
): MasteringPresetStage {
  const { chain, error, runCommand } = options;
  const { t } = useI18n();

  // --- Preset selector -----------------------------------------------------------

  const presetMenuOpen = ref(false);
  const presetQuery = ref('');
  const presetCatalog = ref<string[]>([]);

  const filteredPresets = computed(() =>
    filterPresetCatalog(presetCatalog.value, presetQuery.value),
  );

  const presetLabel = computed(() => {
    const preset = chain.value.preset;
    return preset !== undefined ? humanizePresetName(preset) : t.value.shell.mastering.noPreset;
  });

  function togglePresetMenu(): void {
    if (!presetMenuOpen.value) {
      // Loaded lazily: the wasm catalog may not exist at mount time.
      presetCatalog.value = loadMasteringPresetCatalog();
      presetQuery.value = '';
    }
    presetMenuOpen.value = !presetMenuOpen.value;
  }

  /** Narrows a menu-supplied name to a core preset id through the core's catalog. */
  function corePreset(name: string): MasteringPreset | undefined {
    return getWasmModule()
      .masteringPresetNames()
      .find((id) => id === name);
  }

  function onSelectPreset(preset: string | null): void {
    presetMenuOpen.value = false;
    runCommand(() => {
      if (preset === null) {
        setMasteringPreset(null);
        return;
      }
      const id = corePreset(preset);
      if (id === undefined) {
        throw new RangeError(
          formatMessage(t.value.shell.mastering.unknownPreset, { name: preset }),
        );
      }
      setMasteringPreset(id);
    });
  }
  // --- Preset overrides ---------------------------------------------------------

  /** Runtime parameters from the selected preset, with a safe empty fallback. */
  const presetParams = computed<MasteringChainConfig>(() => {
    const preset = chain.value.preset;
    if (!preset) return {};
    try {
      return getWasmModule().masteringPresetParams(preset);
    } catch {
      return {};
    }
  });

  const PRESET_SECTIONS = ['output', 'restoration'] as const;

  const presetControlSections = computed(() => ({
    output: PRESET_CONTROL_DESCRIPTORS.filter((descriptor) => descriptor.section === 'output'),
    restoration: PRESET_CONTROL_DESCRIPTORS.filter(
      (descriptor) => descriptor.section === 'restoration',
    ),
  }));

  /** Override fields without a typed inspector control, listed under Advanced. */
  const presetOverrideEntries = computed(() =>
    flattenChainConfig(chain.value.presetOverrides ?? {})
      .filter(({ path }) => !isKnownPresetOverrideKey(path))
      .map(({ path, value }) => [path, value] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  function formatOverrideValue(value: unknown): string {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  function presetControlValue(descriptor: PresetControlDescriptor) {
    return resolvePresetControlValue(
      descriptor,
      presetParams.value,
      chain.value.presetOverrides ?? {},
    );
  }

  function presetControlLabel(key: PresetControlKey): string {
    const labels = t.value.shell.mastering.presetOverrides.controls;
    switch (key) {
      case 'loudness.enabled':
        return labels.loudnessEnabled;
      case 'loudness.targetLufs':
        return labels.targetLufs;
      case 'loudness.ceilingDbtp':
        return labels.ceilingDb;
      case 'loudness.truePeakOversample':
        return labels.truePeakOversample;
      case 'loudness.releaseMs':
        return labels.releaseMs;
      case 'loudness.maxLimiterGainReductionDb':
        return labels.maxLimiterGainReductionDb;
      case 'repair.denoise.enabled':
        return labels.denoiseEnabled;
      case 'repair.denoise.reductionDb':
        return labels.denoiseReductionDb;
    }
    return key;
  }

  function presetControlHint(key: PresetControlKey): string {
    const hints = t.value.shell.mastering.presetOverrides.hints;
    switch (key) {
      case 'loudness.enabled':
        return hints.loudnessEnabled;
      case 'loudness.targetLufs':
        return hints.targetLufs;
      case 'loudness.ceilingDbtp':
        return hints.ceilingDb;
      case 'loudness.truePeakOversample':
        return hints.truePeakOversample;
      case 'loudness.releaseMs':
        return hints.releaseMs;
      case 'loudness.maxLimiterGainReductionDb':
        return hints.maxLimiterGainReductionDb;
      case 'repair.denoise.enabled':
        return hints.denoiseEnabled;
      case 'repair.denoise.reductionDb':
        return hints.denoiseReductionDb;
    }
    return '';
  }

  /** Every preset control needs a selected preset to override. */
  const presetBlocked = computed(() =>
    firstBlock([!chain.value.preset, t.value.shell.mastering.reasons.needsPreset]),
  );

  /** A stage parameter only matters while its stage switch is on. */
  const presetControlBlocked = computed<Record<PresetControlKey, string | null>>(() => {
    const reasons = t.value.shell.mastering.reasons;
    const out = {} as Record<PresetControlKey, string | null>;
    for (const descriptor of PRESET_CONTROL_DESCRIPTORS) {
      const enabledKey = presetControlEnabledKey(descriptor.key);
      const enabledDescriptor = enabledKey ? getPresetControlDescriptor(enabledKey) : undefined;
      const stageOff = enabledDescriptor !== undefined && !presetControlValue(enabledDescriptor);
      out[descriptor.key] = firstBlock(presetBlocked.value, [
        stageOff,
        enabledKey === 'loudness.enabled' ? reasons.loudnessOff : reasons.denoiseOff,
      ]);
    }
    return out;
  });

  function presetControlUnit(descriptor: PresetControlDescriptor): string {
    if (descriptor.key === 'loudness.truePeakOversample') {
      return t.value.shell.mastering.presetOverrides.units.times;
    }
    if (descriptor.key === 'loudness.targetLufs') {
      return t.value.shell.mastering.presetOverrides.units.lufs;
    }
    if (descriptor.key === 'loudness.ceilingDbtp') {
      return t.value.shell.mastering.presetOverrides.units.dbtp;
    }
    if (descriptor.key === 'loudness.releaseMs') {
      return t.value.shell.mastering.presetOverrides.units.ms;
    }
    if (descriptor.kind === 'number') return t.value.shell.mastering.presetOverrides.units.db;
    return '';
  }

  function presetControlMin(descriptor: PresetControlDescriptor): number | undefined {
    return descriptor.min;
  }

  function presetControlMax(descriptor: PresetControlDescriptor): number | undefined {
    return descriptor.max;
  }

  function presetControlStep(descriptor: PresetControlDescriptor): number | undefined {
    return descriptor.step;
  }

  function applyPresetControl(key: string, input: unknown): void {
    const descriptor = getPresetControlDescriptor(key);
    const preset = chain.value.preset;
    if (!descriptor || !preset) return;
    try {
      const value = parsePresetControlValue(descriptor, input);
      const overrides = chain.value.presetOverrides ?? {};
      const next = presetControlOverridesForEdit(descriptor, value, presetParams.value, overrides);
      runCommand(() => {
        applyMasteringPresetWithOverrides(preset, next);
      });
    } catch {
      error.value = t.value.shell.mastering.presetOverrides.invalidValue;
    }
  }

  function onPresetControlInput(key: string, event: Event): void {
    const descriptor = getPresetControlDescriptor(key);
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!descriptor || !target) return;
    applyPresetControl(
      key,
      descriptor.kind === 'boolean' ? (target as HTMLInputElement).checked : target.value,
    );
  }

  function onResetPresetControl(key: PresetControlKey): void {
    const overrides = chain.value.presetOverrides ?? {};
    if (!hasPresetControlOverride(key, overrides)) return;
    const descriptor = getPresetControlDescriptor(key);
    const preset = chain.value.preset;
    if (!descriptor || !preset) return;
    const next = presetControlOverridesForReset(descriptor, presetParams.value, overrides);
    runCommand(() => {
      applyMasteringPresetWithOverrides(preset, next);
    });
  }

  function onClearPresetOverride(key: string): void {
    const preset = chain.value.preset;
    if (!preset) return;
    const next = deleteChainPath(chain.value.presetOverrides ?? {}, key);
    runCommand(() => applyMasteringPresetWithOverrides(preset, next));
  }
  return {
    presetMenuOpen,
    presetQuery,
    filteredPresets,
    presetLabel,
    togglePresetMenu,
    onSelectPreset,
    PRESET_SECTIONS,
    presetControlSections,
    presetOverrideEntries,
    formatOverrideValue,
    presetControlValue,
    presetControlLabel,
    presetControlHint,
    presetBlocked,
    presetControlBlocked,
    presetControlUnit,
    presetControlMin,
    presetControlMax,
    presetControlStep,
    onPresetControlInput,
    onResetPresetControl,
    onClearPresetOverride,
  };
}

import type { MixSceneDocument, MixScenePreset } from '@libraz/libsonare';
import { getWasmModule } from '@/project/store';

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  vocalReverbSend: 'Vocal Reverb Send',
  drumBusSubgroup: 'Drum Bus Subgroup',
  commentaryDucking: 'Commentary Ducking',
};

export function humanizeMixerScenePreset(id: string): string {
  const override = LABEL_OVERRIDES[id];
  if (override !== undefined) return override;
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Built-in scene preset names offered by the core. */
export function loadMixerScenePresetCatalog(): MixScenePreset[] {
  return getWasmModule().mixingScenePresetNames();
}

/**
 * Loads a built-in scene preset as the core's typed scene document.
 *
 * @throws RangeError when the core has no preset of that name.
 */
export function loadMixerScenePreset(preset: string): MixSceneDocument {
  const wasm = getWasmModule();
  const name = wasm.mixingScenePresetNames().find((candidate) => candidate === preset);
  if (name === undefined) throw new RangeError(`Unknown mixer scene preset: ${preset}`);
  return wasm.mixingScenePreset(name);
}

/** A built-in scene preset serialized for `applyMixerSceneJson`. */
export function loadMixerScenePresetJson(preset: string): string {
  return JSON.stringify(loadMixerScenePreset(preset));
}

/**
 * The voice-changer preset document a user pastes into the transport bar. The
 * core owns the document's rules, so it is the only validator; this module
 * holds the starting template and turns the core's verdict into a preset.
 */

import type {
  RealtimeVoiceChangerConfig,
  RealtimeVoiceChangerConfigInput,
  VoicePresetId,
} from '@/wasm/index.js';

/** A preset document: the config input that is neither a built-in id nor the flat config. */
export type CustomVoicePreset = Exclude<
  RealtimeVoiceChangerConfigInput,
  VoicePresetId | RealtimeVoiceChangerConfig
>;

/** Starting document for the custom-preset editor: neutral macros, every stage at its default. */
export const CUSTOM_VOICE_PRESET_TEMPLATE = `${JSON.stringify(
  {
    schemaVersion: 4,
    id: 'custom',
    name: 'Custom',
    category: 'custom',
    macros: {},
  } satisfies CustomVoicePreset,
  null,
  2,
)}\n`;

/**
 * Validates a pasted preset document through the core.
 *
 * @returns The normalized document, or null when the core refuses it.
 */
export function parseCustomVoicePreset(
  core: Pick<typeof import('@/wasm/index.js'), 'realtimeVoiceChangerValidatePresetJson'>,
  json: string,
): CustomVoicePreset | null {
  const verdict = core.realtimeVoiceChangerValidatePresetJson(json);
  if (!verdict.ok || verdict.normalizedJson === undefined) return null;
  return JSON.parse(verdict.normalizedJson);
}

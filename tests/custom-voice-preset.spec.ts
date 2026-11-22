import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOM_VOICE_PRESET_TEMPLATE,
  parseCustomVoicePreset,
} from '@/ui/shell/custom-voice-preset';
import * as core from '@/wasm/index.js';

beforeAll(async () => {
  await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
});

describe('custom voice preset', () => {
  it('offers a template the core accepts and the realtime changer starts from', () => {
    const preset = parseCustomVoicePreset(core, CUSTOM_VOICE_PRESET_TEMPLATE);
    expect(preset).not.toBeNull();
    const changer = new core.RealtimeVoiceChanger({
      sampleRate: 48000,
      maxBlockSize: 128,
      numChannels: 1,
      config: preset!,
    });
    changer.destroy();
  });

  it('returns the document the core normalized, macros resolved', () => {
    const preset = parseCustomVoicePreset(
      core,
      JSON.stringify({
        schemaVersion: 4,
        id: 'telephone',
        name: 'Telephone',
        category: 'custom',
        macros: { pitch: 2 },
      }),
    );
    expect(preset).toMatchObject({ schemaVersion: 4, id: 'telephone', name: 'Telephone' });
    expect(preset?.dsp).toMatchObject({ retune: { pitchSemitones: 2 } });
  });

  it.each([
    ['not JSON', '{'],
    ['a 1.x document', JSON.stringify({ schemaVersion: 1, macros: {}, dsp: {} })],
    ['a non-object', '[]'],
  ])('refuses %s', (_label, json) => {
    expect(parseCustomVoicePreset(core, json)).toBeNull();
  });
});

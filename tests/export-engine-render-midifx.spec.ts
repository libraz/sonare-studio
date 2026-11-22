import { describe, expect, it } from 'vitest';
import type { OfflineRenderEngine } from '@/export/engine-render';
import { renderProjectWithEngine } from '@/export/engine-render';
import { DEFAULT_MIDI_FX_CONFIG, midiFxConfig } from '@/project/midi-fx';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { FakeRenderEngine } from './fakes/engine';

/** A recording offline engine over the shared typed fake. */
function makeRecordingEngine(): {
  engine: OfflineRenderEngine;
  calls: Array<[string, ...unknown[]]>;
  named: (name: string) => Array<[string, ...unknown[]]>;
} {
  const engine = new FakeRenderEngine();
  return { engine, calls: engine.calls, named: (name) => engine.named(name) };
}

/** A one-MIDI-track document carrying a single audible note. */
function makeMidiDoc(): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'midi-fx-export-test',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    tracks: [
      {
        name: 'Keys',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'phrase',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      },
    ],
  };
}

describe('renderProjectWithEngine MIDI-FX parity', () => {
  it('installs a track live MIDI-FX insert before scheduling its MIDI', async () => {
    const doc = makeMidiDoc();
    doc.tracks[0].midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    const expectedConfig = midiFxConfig(doc.tracks[0].midiFx);
    const { engine, named, calls } = makeRecordingEngine();

    await renderProjectWithEngine(doc, { deps: null, createEngine: () => engine });

    const midiFxCalls = named('setMidiFx');
    expect(midiFxCalls).toHaveLength(1);
    expect(midiFxCalls[0][2]).toEqual(expectedConfig);
    // The insert is installed after the destination's instrument and before the
    // clips it transforms, matching the live midi-sync order.
    const names = calls.map(([n]) => n);
    expect(names.indexOf('setSynthInstrument')).toBeLessThan(names.indexOf('setMidiFx'));
    expect(names.indexOf('setMidiFx')).toBeLessThan(names.indexOf('setMidiClips'));
  });

  it('does not install an identity MIDI-FX transform', async () => {
    const doc = makeMidiDoc();
    doc.tracks[0].midiFx = { ...DEFAULT_MIDI_FX_CONFIG };
    const { engine, named } = makeRecordingEngine();

    await renderProjectWithEngine(doc, { deps: null, createEngine: () => engine });

    expect(named('setMidiFx')).toEqual([]);
    expect(named('setMidiClips')).toHaveLength(1);
  });

  it('skips a frozen track MIDI-FX (it plays its baked render)', async () => {
    const doc = makeMidiDoc();
    doc.tracks[0].frozen = { assetId: 'frozen-1' };
    doc.tracks[0].midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    const { engine, named } = makeRecordingEngine();

    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: { id: 'frozen-1', name: 'f', sampleRate: 48000, numChannels: 1, numFrames: 1 },
        channels: [new Float32Array(1)],
      }),
    });

    expect(named('setMidiFx')).toEqual([]);
  });
});

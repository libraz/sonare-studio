import { describe, expect, it } from 'vitest';
import type { OfflineRenderEngine } from '@/export/engine-render';
import { renderProjectWithEngine } from '@/export/engine-render';
import { DEFAULT_MIDI_FX_CONFIG, midiFxConfigJson } from '@/project/midi-fx';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';

/**
 * A recording offline engine: a Proxy that stubs every method as a call
 * recorder (so it tracks the whole command stream without re-declaring the
 * large OfflineRenderEngine surface), with real returns only for the few
 * methods renderProjectWithEngine reads a value from.
 */
function makeRecordingEngine(): {
  engine: OfflineRenderEngine;
  calls: Array<[string, ...unknown[]]>;
  named: (name: string) => Array<[string, ...unknown[]]>;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  const realReturns: Record<string, (...args: unknown[]) => unknown> = {
    busAutomationParamId: (busId) => 0x4d590000 | (busId as number),
    process: (channels) => channels,
    destroy: () => undefined,
  };
  const engine = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return realReturns[prop]?.(...args);
        };
      },
    },
  ) as unknown as OfflineRenderEngine;
  return { engine, calls, named: (name) => calls.filter(([n]) => n === name) };
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
    const expectedJson = midiFxConfigJson(doc.tracks[0].midiFx);
    const { engine, named, calls } = makeRecordingEngine();

    await renderProjectWithEngine(doc, { deps: null, createEngine: () => engine });

    const midiFxCalls = named('setMidiFx');
    expect(midiFxCalls).toHaveLength(1);
    expect(midiFxCalls[0][2]).toBe(expectedJson);
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

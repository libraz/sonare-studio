import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  midiNoteTargets,
  type TuneToMidiDeps,
  type TuneToMidiRefusedError,
  tuneAudioClipToMidi,
} from '@/project/audio-tune-to-midi';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { EditorClip } from '@/project/types';
import type { NoteObject } from '@/wasm/index.js';

const TEMPO_120 = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);

function audioClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Vocal',
    startPpq: 8,
    lengthPpq: 16,
    sourceOffsetPpq: 4,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'take',
    ...overrides,
  };
}

function midiClip(
  notes: Array<{ pitch: number; startPpq: number; durationPpq: number }>,
): EditorClip {
  return {
    id: 2,
    trackId: 2,
    name: 'Melody',
    startPpq: 8,
    lengthPpq: 16,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: notes.map((note, id) => ({ id, velocity: 100, ...note })),
  };
}

function stereoAsset(frames = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'take', name: 'take', sampleRate: 48000, numChannels: 2, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(0.5)],
  };
}

function note(onsetSample: number, offsetSample: number): NoteObject {
  return {
    onsetSample,
    offsetSample,
    frameStart: 0,
    frameEnd: 1,
    medianHz: 440,
    medianCents: 0,
    f0Stability: 1,
    amplitude: new Float32Array(1),
    edit: {} as NoteObject['edit'],
  };
}

function deps(overrides: Partial<TuneToMidiDeps> = {}): TuneToMidiDeps {
  return {
    loadAudioAsset: async () => stereoAsset(),
    pitchPyin: vi.fn(() => ({ f0: new Float32Array([440]), voicedFlag: [1] })),
    extractNotes: vi.fn(() => [note(0, 100)]),
    assignNoteTargets: vi.fn((request) => ({ notes: request.notes, assignedCount: 1 })),
    renderNotes: vi.fn((request) => Float32Array.from(request.samples, (value) => value * 2)),
    ...overrides,
  };
}

describe('midiNoteTargets', () => {
  it('places MIDI notes in seconds of an asset starting at the given timeline PPQ', () => {
    // 120 BPM: 0.5 s per quarter. The asset's first frame sits at PPQ 4.
    const targets = midiNoteTargets(
      [midiClip([{ pitch: 69, startPpq: 0, durationPpq: 2 }])],
      TEMPO_120,
      4,
    );
    // The note sits at timeline PPQ 8..10, i.e. 2..3 s into the asset.
    expect(targets).toEqual([{ startSec: 2, endSec: 3, targetMidi: 69 }]);
  });

  it('drops notes that end before the asset starts and clamps ones that straddle it', () => {
    const targets = midiNoteTargets(
      [
        midiClip([
          { pitch: 60, startPpq: 0, durationPpq: 1 },
          { pitch: 62, startPpq: 2, durationPpq: 4 },
        ]),
      ],
      TEMPO_120,
      12,
    );
    expect(targets).toEqual([{ startSec: 0, endSec: 1, targetMidi: 62 }]);
  });
});

describe('tuneAudioClipToMidi', () => {
  const reference = [midiClip([{ pitch: 69, startPpq: 0, durationPpq: 4 }])];

  it('measures the take once and renders the same note edits on every channel', async () => {
    const injected = deps();
    const tuned = await tuneAudioClipToMidi(audioClip(), reference, TEMPO_120, 'leave', injected);

    expect(injected.pitchPyin).toHaveBeenCalledTimes(1);
    expect(injected.assignNoteTargets).toHaveBeenCalledWith(
      expect.objectContaining({ unmatchedPolicy: 'leave', sampleRate: 48000 }),
    );
    expect(injected.renderNotes).toHaveBeenCalledTimes(2);
    expect(tuned?.channels.map((channel) => channel[0])).toEqual([0.5, 1]);
    expect(tuned).toMatchObject({ noteCount: 1, assignedCount: 1, sampleRate: 48000 });
  });

  it('refuses a clip that does not play its asset straight', async () => {
    const refusal = (clip: EditorClip) =>
      tuneAudioClipToMidi(clip, reference, TEMPO_120, 'leave', deps()).catch(
        (error: TuneToMidiRefusedError) => error.reason,
      );
    expect(await refusal(audioClip({ warp: { enabled: true, sourceBpm: 120, anchors: [] } }))).toBe(
      'warped',
    );
    expect(await refusal(audioClip({ loopEnabled: true, loopLengthPpq: 4 }))).toBe('looped');
    expect(await refusal(audioClip({ takes: [{ assetId: 'a', name: 'A' }] }))).toBe('comped');
  });

  it('refuses a reference with no notes over the recording', async () => {
    await expect(
      tuneAudioClipToMidi(audioClip(), [midiClip([])], TEMPO_120, 'leave', deps()),
    ).rejects.toMatchObject({ reason: 'no-notes' });
  });
});

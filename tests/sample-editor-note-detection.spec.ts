import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { useSampleMarkers } from '@/ui/sample-editor/use-sample-markers';
import type { SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';
import * as core from '@/wasm/index.js';
import { noteSegment, pitchResult } from './fakes/analysis';

/** A three-note contour: two legato notes then one after a rest. */
const CONTOUR = pitchResult({
  f0: new Float32Array([220, 220, 262, 262, 0, 330]),
  // Below the segmenter's voicing gate on purpose: the tracker's confidence
  // must not be what decides voicing.
  voicedProb: new Float32Array([0.44, 0.43, 0.42, 0.41, 0.01, 0.4]),
  voicedFlag: [true, true, true, true, false, true],
  medianF0: 262,
});

const SEGMENTS = [
  noteSegment({ frameStart: 0, frameEnd: 2, startSec: 0, endSec: 0.25, medianCents: -900 }),
  noteSegment({ frameStart: 2, frameEnd: 4, startSec: 0.25, endSec: 0.5, medianCents: -500 }),
  noteSegment({ frameStart: 5, frameEnd: 6, startSec: 0.75, endSec: 1, medianCents: -200 }),
];

function asset(sampleRate = 48000, numFrames = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'a', name: 'a', sampleRate, numChannels: 1, numFrames },
    channels: [new Float32Array(numFrames)],
  };
}

function harness(ops: SampleEditorWasmOps | null, loaded: LoadedAudioAsset = asset()) {
  const busy = ref(false);
  const errors: string[] = [];
  const markers = useSampleMarkers({
    wasmOps: () => ops,
    asset: () => loaded,
    silenceThresholdInput: () => '40',
    busy,
    setError: (message) => {
      errors.push(message);
    },
    clearError: () => {
      errors.length = 0;
    },
  });
  return { markers, busy, errors };
}

const workingOps: SampleEditorWasmOps = {
  pitchPyin: () => CONTOUR,
  noteSegments: () => SEGMENTS,
};

describe('useSampleMarkers note detection', () => {
  it('marks both ends of every note and keeps the regions for labelling', async () => {
    const { markers } = harness(workingOps);
    await markers.onDetectNotes();

    // 0.25 s and 0.5 s at 48 kHz; the legato pair shares its inner edge, and
    // the start of the file needs no cut.
    expect(markers.onsetFrames.value).toEqual([12000, 24000, 36000]);
    expect(markers.noteRegions.value).toEqual([
      { startFrame: 0, endFrame: 12000, midi: 60 },
      { startFrame: 12000, endFrame: 24000, midi: 64 },
      { startFrame: 36000, endFrame: 48000, midi: 67 },
    ]);
  });

  it('holds the editor busy across the pass and releases it on failure', async () => {
    const { markers, busy } = harness(workingOps);
    const seen: boolean[] = [];
    const pending = markers.onDetectNotes();
    seen.push(busy.value);
    await pending;
    seen.push(busy.value);
    expect(seen).toEqual([true, false]);

    const failing = harness({
      pitchPyin: () => CONTOUR,
      noteSegments: () => {
        throw new Error('segmenter exploded');
      },
    });
    await failing.markers.onDetectNotes();
    expect(failing.busy.value).toBe(false);
    expect(failing.errors).toEqual(['segmenter exploded']);
    expect(failing.markers.onsetFrames.value).toEqual([]);
  });

  it('refuses to start a second pass while one is running', async () => {
    const noteSegments = vi.fn(() => SEGMENTS);
    const { markers, busy } = harness({ pitchPyin: () => CONTOUR, noteSegments });
    const first = markers.onDetectNotes();
    await markers.onDetectNotes();
    await first;
    expect(busy.value).toBe(false);
    expect(noteSegments).toHaveBeenCalledTimes(1);
  });

  it('drops the note regions when another detector replaces the markers', async () => {
    const { markers } = harness({
      ...workingOps,
      detectOnsets: () => new Float32Array([0.1]),
      splitSilence: () => new Int32Array([0, 24000, 30000, 48000]),
    });

    await markers.onDetectNotes();
    expect(markers.noteRegions.value).toHaveLength(3);

    markers.onDetectTransients();
    expect(markers.onsetFrames.value).toEqual([4800]);
    expect(markers.noteRegions.value).toEqual([]);

    await markers.onDetectNotes();
    markers.onSplitSilence();
    expect(markers.onsetFrames.value).toEqual([24000, 30000]);
    expect(markers.noteRegions.value).toEqual([]);

    await markers.onDetectNotes();
    markers.onClearTransients();
    expect(markers.onsetFrames.value).toEqual([]);
    expect(markers.noteRegions.value).toEqual([]);
  });

  it('reports an engine without a note segmenter instead of throwing', async () => {
    const { markers, errors } = harness({ pitchPyin: () => CONTOUR });
    await markers.onDetectNotes();
    expect(errors[0]).toMatch(/unavailable/);
    expect(markers.noteRegions.value).toEqual([]);
  });

  it('does nothing without a loaded module', async () => {
    const { markers, busy } = harness(null);
    await markers.onDetectNotes();
    expect(busy.value).toBe(false);
    expect(markers.onsetFrames.value).toEqual([]);
  });
});

describe('useSampleMarkers note detection with the real core', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  });

  it('finds the note of a sustained A4 through pYIN and the segmenter', async () => {
    const sampleRate = 22050;
    const tone = Float32Array.from(
      { length: sampleRate },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
    );
    const loaded: LoadedAudioAsset = {
      meta: { id: 't', name: 't', sampleRate, numChannels: 1, numFrames: tone.length },
      channels: [tone],
    };
    const { markers, errors } = harness(core, loaded);

    await markers.onDetectNotes();

    expect(errors).toEqual([]);
    expect(markers.noteRegions.value.length).toBeGreaterThan(0);
    expect(markers.noteRegions.value[0].midi).toBeCloseTo(69, 0);
  });
});

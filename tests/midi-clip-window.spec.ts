import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecordedMidiClip,
  clearHistory,
  copyActiveClip,
  glueMidiClips,
  pasteClipAt,
  setClipFades,
  setClipGain,
  setClipLoop,
  setClipMidiCompSegments,
  splitClip,
  trimClip,
  undo,
} from '@/project/commands';
import { expandExpressionPoints } from '@/project/midi-cc';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { getProject, useProjectStore } from '@/project/store';
import type { ClipCcPoint, EditorClip } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const RAMP: ClipCcPoint[] = [
  { ppq: 0, value: 0, curve: 'linear' },
  { ppq: 4, value: 127 },
];

describe('deriving a MIDI clip from a window of another clip', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function clipById(clipId: number): EditorClip {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) throw new Error(`missing clip ${clipId}`);
    return clip;
  }

  function engineEventPpqs(clipId: number): number[] {
    const doc = JSON.parse(getProject().toJson()) as {
      midi_content?: Record<string, Array<{ ppq: number }>>;
    };
    return (doc.midi_content?.[String(clipId)] ?? []).map((event) => event.ppq).sort();
  }

  function expanded(points: ReadonlyArray<ClipCcPoint>, lengthPpq: number, shift = 0) {
    return expandExpressionPoints(points, lengthPpq, 127).map((point) => ({
      ppq: point.ppq + shift,
      value: point.value,
    }));
  }

  function expectSameCurve(
    actual: ReadonlyArray<{ ppq: number; value: number }>,
    source: ReadonlyArray<{ ppq: number; value: number }>,
    fromPpq: number,
    toPpq: number,
  ): void {
    const window = source.filter((point) => point.ppq >= fromPpq - 1e-9 && point.ppq < toPpq);
    expect(window.length).toBeGreaterThan(0);
    for (const point of window) {
      const match = actual.find((candidate) => Math.abs(candidate.ppq - point.ppq) < 1e-9);
      expect(match, `event at ${point.ppq}`).toBeDefined();
      // Breakpoint values are integers, so a cut point may round by one step.
      expect(Math.abs((match?.value ?? -99) - point.value)).toBeLessThanOrEqual(1);
    }
  }

  it('keeps a note crossing the split in both halves, in notes and engine events', () => {
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 40,
      lengthPpq: 8,
      notes: [
        { pitch: 60, velocity: 90, startPpq: 2, durationPpq: 4, channel: 0 },
        { pitch: 64, velocity: 80, startPpq: 6, durationPpq: 1, channel: 0 },
      ],
    });
    const rightId = splitClip(clipId, 44);

    expect(clipById(clipId).notes.map((n) => [n.pitch, n.startPpq, n.durationPpq])).toEqual([
      [60, 2, 2],
    ]);
    expect(clipById(rightId).notes.map((n) => [n.pitch, n.startPpq, n.durationPpq])).toEqual([
      [60, 4, 2],
      [64, 6, 1],
    ]);
    expect(engineEventPpqs(clipId)).toEqual([2, 4]);
    expect(engineEventPpqs(rightId)).toEqual([4, 6, 6, 7]);

    undo();
    expect(clipById(clipId).notes.map((n) => [n.pitch, n.startPpq, n.durationPpq])).toEqual([
      [60, 2, 4],
      [64, 6, 1],
    ]);
  });

  it('interpolates a ramping lane at a split so both halves play the source curve', () => {
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 40,
      lengthPpq: 8,
      notes: [],
      ccLanes: [{ controller: 11, channel: 0, points: RAMP }],
      programChangeLanes: [{ channel: 0, points: [{ ppq: 0, program: 5 }] }],
    });
    const rightId = splitClip(clipId, 42);
    const left = clipById(clipId);
    const right = clipById(rightId);
    const leftPoints = left.ccLanes?.[0].points ?? [];
    const rightPoints = right.ccLanes?.[0].points ?? [];

    expect(leftPoints.at(-1)).toMatchObject({ ppq: 2, value: 64 });
    expect(rightPoints[0]).toMatchObject({ ppq: 0, value: 64, curve: 'linear' });
    const joined = [...expanded(leftPoints, 2), ...expanded(rightPoints, 6, 2)];
    expectSameCurve(joined, expanded(RAMP, 8), 0, 8);
    // Program changes hold: the right half re-sends the held program, the left gains no end point.
    expect(left.programChangeLanes?.[0].points).toEqual([{ ppq: 0, program: 5 }]);
    expect(right.programChangeLanes?.[0].points).toEqual([{ ppq: 0, program: 5 }]);
  });

  it('comps a take from inside a ramp starting at the interpolated value', () => {
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 40,
      lengthPpq: 4,
      notes: [],
      midiTakes: [
        {
          name: 'Flat',
          notes: [],
          ccLanes: [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 10 }] }],
        },
        { name: 'Ramp', notes: [], ccLanes: [{ controller: 11, channel: 0, points: RAMP }] },
      ],
    });
    setClipMidiCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    const lanes = clipById(clipId).ccLanes ?? [];
    expect(lanes).toHaveLength(1);
    const points = lanes[0].points;
    expect(points.find((point) => point.ppq === 2)).toMatchObject({ value: 64, curve: 'linear' });
    expectSameCurve(expanded(points, 4), expanded(RAMP, 4), 2, 4);
  });

  it('pastes a trimmed, looped MIDI clip with its window, gain, fades and audible notes', () => {
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 40,
      lengthPpq: 8,
      notes: [
        { pitch: 60, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 },
        { pitch: 62, velocity: 90, startPpq: 5, durationPpq: 1, channel: 0 },
      ],
    });
    trimClip(clipId, 44, 4);
    setClipLoop(clipId, true, 2);
    setClipGain(clipId, 0.5);
    setClipFades(clipId, 0.5, 1);
    store.clipId = clipId;
    const source = clipById(clipId);
    expect(copyActiveClip()).toBe(true);

    const pastedId = pasteClipAt(store.tracks[0].id, 80);
    expect(pastedId).not.toBeNull();
    const pasted = clipById(pastedId as number);
    expect(pasted).toMatchObject({
      sourceOffsetPpq: source.sourceOffsetPpq,
      lengthPpq: source.lengthPpq,
      loopEnabled: true,
      loopLengthPpq: 2,
      gain: 0.5,
      fadeInPpq: 0.5,
      fadeOutPpq: 1,
    });
    const audible = (clip: EditorClip, origin: number) =>
      projectMidiNoteOccurrences(clip).map((note) => [
        note.pitch,
        note.startPpq - origin,
        note.durationPpq,
      ]);
    expect(audible(pasted, 80)).toEqual(audible(source, 44));
    expect(audible(pasted, 80).map(([pitch]) => pitch)).toEqual([62, 62]);
  });

  describe('glueMidiClips', () => {
    function abuttingClips(): { first: number; second: number } {
      const trackId = store.tracks[0].id;
      const first = addRecordedMidiClip({
        trackId,
        startPpq: 40,
        lengthPpq: 4,
        notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
      });
      const second = addRecordedMidiClip({
        trackId,
        startPpq: 44,
        lengthPpq: 4,
        notes: [{ pitch: 62, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 }],
      });
      return { first, second };
    }

    it('keeps the shared gain, the outer fades and the SysEx at their timeline positions', () => {
      const { first, second } = abuttingClips();
      setClipGain(first, 0.25);
      setClipGain(second, 0.25);
      setClipFades(first, 1, 0);
      setClipFades(second, 0, 2);
      store.clips = store.clips.map((clip) =>
        clip.id === second
          ? { ...clip, smfSysEx: [{ ppq: 1, status: 0xf0, data: [0x41, 0x10, 0xf7] }] }
          : clip,
      );
      const glued = clipById(glueMidiClips([first, second]));
      expect(glued).toMatchObject({ gain: 0.25, fadeInPpq: 1, fadeOutPpq: 2 });
      expect(glued.smfSysEx).toEqual([{ ppq: 5, status: 0xf0, data: [0x41, 0x10, 0xf7] }]);
      expect(glued.notes.map((note) => [note.pitch, note.startPpq])).toEqual([
        [60, 0],
        [62, 5],
      ]);
    });

    it('leaves out the notes of a silenced source', () => {
      const { first, second } = abuttingClips();
      setClipGain(second, 0);
      const glued = clipById(glueMidiClips([first, second]));
      expect(glued.gain).toBe(1);
      expect(glued.notes.map((note) => note.pitch)).toEqual([60]);
    });

    it('refuses sources whose gain or interior fades one clip cannot reproduce', () => {
      const { first, second } = abuttingClips();
      setClipGain(second, 0.5);
      expect(() => glueMidiClips([first, second])).toThrow(/same gain/);
      setClipGain(second, 1);
      setClipFades(first, 0, 1);
      expect(() => glueMidiClips([first, second])).toThrow(/outer edges/);
    });
  });
});

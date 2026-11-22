import type { ProjectMidiEvent, TranscribeResult } from '@libraz/libsonare';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import { PIANO_ROLL_COLORS } from '@/components/piano-roll/theme';
import { floorLocalPpqToMeterGrid } from '@/components/piano-roll/timeline-meter';
import type { NoteInteractions } from '@/components/piano-roll/use-note-interactions';
import { useStepInput } from '@/composables/useStepInput';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipMelody } from '@/project/audio-melody';
import { quantizeNotes, transcribeAudioClip } from '@/project/audio-transcription';
import { finalizeRecording } from '@/project/midi-recording';
import { useProjectStore } from '@/project/store';
import {
  measureGrid,
  meterGridLines,
  snapClipPpqToMeterGrid,
  snapPpqToMeterGrid,
} from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

vi.mock('@/project/commands', () => ({
  addNote: vi.fn(() => 1),
  noteEndLimitPpq: vi.fn(() => Number.POSITIVE_INFINITY),
}));

const FOUR_THEN_THREE: TimeSignatureSegment[] = [
  { startPpq: 0, numerator: 4, denominator: 4 },
  { startPpq: 4, numerator: 3, denominator: 4 },
];

/** True when `ppq` is a barline of the meter map. */
function isBarline(meter: readonly TimeSignatureSegment[], ppq: number): boolean {
  return measureGrid(meter, 0, ppq + 8).some((measure) => Math.abs(measure.startPpq - ppq) < 1e-9);
}

describe('meter grid snap', () => {
  it('never rounds past a meter change onto the old meter grid', () => {
    expect(snapPpqToMeterGrid(FOUR_THEN_THREE, 3.9, 1.5)).toBe(4);
    expect(snapPpqToMeterGrid(FOUR_THEN_THREE, 3.4, 1.5)).toBe(3);
    expect(snapPpqToMeterGrid(FOUR_THEN_THREE, 5.4, 1.5)).toBe(5.5);
  });

  it('keeps every barline a grid point when the step does not divide the bar', () => {
    const sevenEight: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 7, denominator: 8 }];
    expect(snapPpqToMeterGrid(sevenEight, 3.48, 1 / 3)).toBe(3.5);
    expect(snapPpqToMeterGrid(sevenEight, 3.85, 1 / 3)).toBeCloseTo(3.5 + 1 / 3, 12);
  });

  it('snaps a clip-relative position on the timeline grid, not from the clip start', () => {
    expect(snapClipPpqToMeterGrid([], 0.3, 3.72, 0.25)).toBeCloseTo(3.7, 12);
    expect(snapClipPpqToMeterGrid(FOUR_THEN_THREE, 0.5, 6.2, 'bar')).toBeCloseTo(6.5, 12);
  });

  it('floors to the cell start when the barline is the nearest snap point', () => {
    const sevenEight: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 7, denominator: 8 }];
    expect(floorLocalPpqToMeterGrid(sevenEight, 0, 3.45, 1 / 3)).toBeCloseTo(10 / 3, 12);
    expect(floorLocalPpqToMeterGrid(sevenEight, 0.5, 3.9, 1 / 3)).toBeCloseTo(
      3.5 + 2 / 3 - 0.5,
      12,
    );
  });

  it('lists exactly the positions the snap returns', () => {
    const lines = meterGridLines(FOUR_THEN_THREE, 3, 9, 1.5);
    expect(lines).toEqual([3, 4, 5.5, 7, 8.5]);
    for (const line of lines) expect(snapPpqToMeterGrid(FOUR_THEN_THREE, line, 1.5)).toBe(line);
  });
});

describe('piano-roll fine gridlines', () => {
  const painter: Painter = { schedule: vi.fn(), dispose: vi.fn() };
  let wrapper: VueWrapper | null = null;
  let fineLineXs: number[] = [];

  function fakeContext(): CanvasRenderingContext2D {
    const ctx: Record<string, unknown> = { strokeStyle: '', fillStyle: '', lineWidth: 1 };
    for (const name of [
      'setTransform',
      'clearRect',
      'strokeRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'closePath',
      'fill',
      'stroke',
      'save',
      'restore',
      'rect',
      'clip',
      'fillText',
      'roundRect',
      'setLineDash',
    ]) {
      ctx[name] = vi.fn();
    }
    ctx.fillRect = vi.fn((x: number, _y: number, width: number) => {
      if (ctx.fillStyle === PIANO_ROLL_COLORS.gridFine && width === 1) fineLineXs.push(x);
    });
    ctx.measureText = vi.fn(() => ({ width: 10 }));
    return ctx as unknown as CanvasRenderingContext2D;
  }

  beforeEach(() => {
    fineLineXs = [];
    vi.mocked(painter.schedule).mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext as never);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws fine lines where the snap lands for a clip off the grid', async () => {
    const origin = 0.3;
    const range = new TimelineRange({ widthPx: 400, heightPx: 200, pxPerPpq: 100, rowHeight: 14 });
    wrapper = mount(NoteGridCanvas, {
      props: {
        range,
        revision: 0,
        painter,
        notes: [],
        selection: new Set<number>(),
        highlightedPitchClasses: Array.from({ length: 12 }, () => false),
        gridPpq: 0.25,
        clipLengthPpq: 4,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        timeSignatureOriginPpq: origin,
        interactions: {
          marquee: ref(null),
          previewNotes: ref(null),
          cursor: ref('default'),
          hitNoteAt: vi.fn(() => null),
        } as unknown as NoteInteractions,
      },
    });
    await wrapper.setProps({ revision: 1 });
    const calls = vi
      .mocked(painter.schedule)
      .mock.calls.filter(([layer]) => layer.startsWith('note-grid-background-'));
    calls[calls.length - 1]?.[1]();

    expect(fineLineXs.length).toBeGreaterThan(0);
    for (const x of fineLineXs) {
      const local = x / 100;
      expect(snapClipPpqToMeterGrid([], origin, local + 0.001, 0.25)).toBeCloseTo(local, 2);
    }
    expect(fineLineXs).toContain(Math.round(range.ppqToX(0.7)));
    expect(fineLineXs).not.toContain(Math.round(range.ppqToX(0.75)));
  });
});

describe('step input back in Bar snap', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('lands on the previous bar start across a meter change', () => {
    const store = useProjectStore();
    store.snapBar = true;
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 4, denominator: 4 },
    ];
    const step = useStepInput();
    step.setCursor(6);
    step.back();
    expect(step.cursorPpq.value).toBe(3);
    step.setCursor(7.5);
    step.back();
    expect(step.cursorPpq.value).toBe(6);
    step.setCursor(0);
    step.back();
    expect(step.cursorPpq.value).toBe(0);
  });
});

describe('MIDI recording quantize', () => {
  const on = (ppq: number, pitch = 60) =>
    ({ ppq, kind: 'on', pitch, velocity: 100, channel: 0 }) as const;
  const off = (ppq: number, pitch = 60) =>
    ({ ppq, kind: 'off', pitch, velocity: 0, channel: 0 }) as const;

  it('snaps to the timeline grid whatever the punch-in position', () => {
    const result = finalizeRecording([on(4.02), off(4.5)], {
      startPpq: 3.37,
      stopPpq: 6,
      gridPpq: 0.25,
    });
    expect(result?.notes[0].startPpq).toBeCloseTo(4 - 3.37, 12);
  });

  it('keeps downbeats unswung after an off-beat punch-in', () => {
    const result = finalizeRecording([on(1.02), off(1.3)], {
      startPpq: 0.1,
      stopPpq: 2,
      gridPpq: 0.5,
      quantizeSwingPercent: 100,
    });
    expect(result?.notes[0].startPpq).toBeCloseTo(0.9, 12);
  });

  it('re-anchors the grid at a meter change', () => {
    const meter: TimeSignatureSegment[] = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];
    const result = finalizeRecording([on(3.95), off(4.5)], {
      startPpq: 2,
      stopPpq: 6,
      gridPpq: 1.5,
      timeSignatures: meter,
    });
    expect(result?.notes[0].startPpq).toBeCloseTo(2, 12);
  });
});

describe('audio-to-MIDI rhythm quantize', () => {
  it('lands melody notes on the timeline grid for a clip off the grid', async () => {
    // 120 BPM: 1 s = 2 PPQ. A note at clip-relative 3.7 sits on absolute 4.0.
    const frames = 96000;
    const notes = await analyzeAudioClipMelody(
      { assetId: 'asset-1', startPpq: 0.3, lengthPpq: 4, sourceOffsetPpq: 0 },
      120,
      {
        loadAudioAsset: async () =>
          ({
            meta: {
              id: 'asset-1',
              name: 'a',
              sampleRate: 48000,
              numChannels: 1,
              numFrames: frames,
            },
            channels: [new Float32Array(frames).fill(0.5)],
          }) as LoadedAudioAsset,
        analyzeMelody: () => ({
          points: [
            { timeSec: 1.86, frequencyHz: 440, confidence: 1 },
            { timeSec: 1.96, confidence: 0 },
          ],
        }),
      },
      { rhythmQuantizePpq: 0.25 },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].startPpq).toBeCloseTo(3.7, 9);
    for (const note of notes) {
      expect((0.3 + note.startPpq) / 0.25).toBeCloseTo(Math.round((0.3 + note.startPpq) / 0.25), 9);
    }
  });

  it('lands transcribed notes on the timeline grid without a matched beat grid', async () => {
    const frames = 5_000;
    const source: LoadedAudioAsset = {
      meta: { id: 'a', name: 'a', sampleRate: 1_000, numChannels: 1, numFrames: frames },
      channels: [Float32Array.from({ length: frames }, (_, frame) => (frame % 7) / 10)],
    };
    const event = (ppq: number, status: 0x8 | 0x9, velocity: number): ProjectMidiEvent => ({
      ppq,
      word0: (0x20000000 | (status << 20) | (60 << 8) | velocity) >>> 0,
    });
    const result: TranscribeResult = {
      events: [event(1.08, 0x9, 90), event(2.2, 0x8, 0), event(3.72, 0x9, 90), event(4.1, 0x8, 0)],
      noteCount: 2,
      tempoBpm: 60,
      tuningCents: 0,
    };
    const { notes } = await transcribeAudioClip(
      { assetId: 'a', startPpq: 0.3, lengthPpq: 4.5, sourceOffsetPpq: 0 },
      60,
      { loadAudioAsset: async () => source, transcribe: async () => result },
      { polyphonic: false, rhythmQuantizePpq: 0.25 },
    );
    expect(notes.map((note) => note.startPpq)).toEqual([
      expect.closeTo(1.2, 9),
      expect.closeTo(3.7, 9),
    ]);
    for (const note of notes) {
      const absolute = 0.3 + note.startPpq;
      expect(absolute / 0.25).toBeCloseTo(Math.round(absolute / 0.25), 9);
    }
  });

  it('snaps to the meter map barlines in Bar mode across a meter change', () => {
    const notes = quantizeNotes(
      [
        { startPpq: 3.1, durationPpq: 2.5 },
        { startPpq: 6.9, durationPpq: 2.2 },
      ],
      'bar',
      12,
      0.5,
      FOUR_THEN_THREE,
    );
    expect(
      notes.map((note) => [0.5 + note.startPpq, 0.5 + note.startPpq + note.durationPpq]),
    ).toEqual([
      [4, 7],
      [7, 10],
    ]);
    for (const note of notes) {
      expect(isBarline(FOUR_THEN_THREE, 0.5 + note.startPpq)).toBe(true);
      expect(isBarline(FOUR_THEN_THREE, 0.5 + note.startPpq + note.durationPpq)).toBe(true);
    }
  });
});

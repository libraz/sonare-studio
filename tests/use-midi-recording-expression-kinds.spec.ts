import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { type UseMidiRecordingReturn, useMidiRecording } from '@/composables/useMidiRecording';
import type { AddRecordedMidiClipInput } from '@/project/commands';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { fakeTransport } from './fakes/composables';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

type LaneField =
  | 'ccLanes'
  | 'pitchBendLanes'
  | 'programChangeLanes'
  | 'channelPressureLanes'
  | 'polyPressureLanes';

/** One expression kind: how to capture it and what lane it records. */
interface KindCase {
  name: string;
  field: LaneField;
  capture(
    recording: UseMidiRecordingReturn,
    key: number,
    value: number,
    timeStampMs?: number,
  ): void;
  lane(key: number, points: ReadonlyArray<readonly [number, number]>): object;
  /** An out-of-range value and the value it records as, or null when the point is dropped. */
  outOfRange: readonly [number, number | null];
  /** True when two points on one position collapse to the later one. */
  dedupesPosition: boolean;
}

const valuePoints = (points: ReadonlyArray<readonly [number, number]>) =>
  points.map(([ppq, value]) => ({ ppq, value }));

const KINDS: KindCase[] = [
  {
    name: 'control change',
    field: 'ccLanes',
    capture: (r, key, value, timeStampMs) =>
      r.captureControlChange({ controller: key, value, channel: 0, timeStampMs }),
    lane: (key, points) => ({ controller: key, channel: 0, points: valuePoints(points) }),
    outOfRange: [200, 127],
    dedupesPosition: true,
  },
  {
    name: 'pitch bend',
    field: 'pitchBendLanes',
    capture: (r, key, value, timeStampMs) =>
      r.capturePitchBend({ value, channel: key, timeStampMs }),
    lane: (key, points) => ({ channel: key, points: valuePoints(points) }),
    outOfRange: [20000, 16383],
    dedupesPosition: true,
  },
  {
    name: 'program change',
    field: 'programChangeLanes',
    capture: (r, key, value, timeStampMs) =>
      r.captureProgramChange({ program: value, channel: key, timeStampMs }),
    lane: (key, points) => ({
      channel: key,
      points: points.map(([ppq, program]) => ({ ppq, program })),
    }),
    outOfRange: [200, null],
    dedupesPosition: false,
  },
  {
    name: 'channel pressure',
    field: 'channelPressureLanes',
    capture: (r, key, value, timeStampMs) =>
      r.captureChannelPressure({ value, channel: key, timeStampMs }),
    lane: (key, points) => ({ channel: key, points: valuePoints(points) }),
    outOfRange: [200, 127],
    dedupesPosition: true,
  },
  {
    name: 'poly pressure',
    field: 'polyPressureLanes',
    capture: (r, key, value, timeStampMs) =>
      r.capturePolyPressure({ pitch: key, value, channel: 0, timeStampMs }),
    lane: (key, points) => ({ channel: 0, pitch: key, points: valuePoints(points) }),
    outOfRange: [200, 127],
    dedupesPosition: true,
  },
];

const ALL_FIELDS: LaneField[] = KINDS.map((kind) => kind.field);

/** A recorder over a writable playhead whose recording command logs its input. */
function setup(now?: () => number) {
  const positionPpq = ref(0);
  const transport = fakeTransport({
    isPlaying: ref(false),
    positionPpq,
    audiblePositionPpq: positionPpq,
    playbackLatencySeconds: ref(0),
    play: vi.fn(() => true),
    stop: vi.fn(() => true),
    seekPpq: vi.fn((ppq: number) => {
      positionPpq.value = ppq;
      return true;
    }),
  });
  const added: AddRecordedMidiClipInput[] = [];
  const recording = useMidiRecording(transport, {
    now,
    addRecordedMidiClip: (input) => {
      added.push(input);
      return 1;
    },
  });
  return { recording, transport, positionPpq, added };
}

/** Fields other than `field` are absent from a clip or take input. */
function expectOnly(input: object, field: LaneField): void {
  for (const other of ALL_FIELDS) {
    if (other !== field) expect(input).not.toHaveProperty(other);
  }
}

describe.each(KINDS)('useMidiRecording records $name', (kind) => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  /** Records a 4-8 loop: values 10 at 4.5 and 20 at 5.5, then 30 at 4.75 in the second pass. */
  function recordTwoPasses(mode: 'takes' | 'overdub' | 'keep-last') {
    const harness = setup();
    const { recording, transport, positionPpq } = harness;
    recording.arm(store.tracks[0].id);
    recording.cycleRecordMode.value = mode;
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 4;
    transport.loopEndPpq.value = 8;
    positionPpq.value = 4;
    recording.record();
    positionPpq.value = 4.5;
    kind.capture(recording, 1, 10);
    positionPpq.value = 5.5;
    kind.capture(recording, 1, 20);
    positionPpq.value = 4.75;
    kind.capture(recording, 1, 30);
    positionPpq.value = 6;
    return { ...harness, result: recording.stopRecord() };
  }

  it('commits an expression-only take with lanes in first-capture order', () => {
    const { recording, positionPpq, added } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 1;
    kind.capture(recording, 5, 30);
    positionPpq.value = 2;
    kind.capture(recording, 3, 40);
    positionPpq.value = 3;
    kind.capture(recording, 5, 50);
    positionPpq.value = 4;

    expect(recording.stopRecord()).toBe(1);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ startPpq: 0, lengthPpq: 4, notes: [] });
    expect(added[0][kind.field]).toEqual([
      kind.lane(5, [
        [1, 30],
        [3, 50],
      ]),
      kind.lane(3, [[2, 40]]),
    ]);
    expectOnly(added[0], kind.field);
  });

  it('normalizes an out-of-range value and a repeated position', () => {
    const { recording, positionPpq, added } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 1;
    kind.capture(recording, 1, kind.outOfRange[0]);
    positionPpq.value = 2;
    kind.capture(recording, 1, 7);
    kind.capture(recording, 1, 9);
    positionPpq.value = 4;

    expect(recording.stopRecord()).toBe(1);
    const clamped = kind.outOfRange[1];
    const points: Array<readonly [number, number]> = [];
    if (clamped !== null) points.push([1, clamped]);
    if (kind.dedupesPosition) points.push([2, 9]);
    else points.push([2, 7], [2, 9]);
    expect(added[0][kind.field]).toEqual([kind.lane(1, points)]);
  });

  it('drops a point captured before the count-in punch-in', () => {
    let nowMs = 1000;
    const { recording, positionPpq, added } = setup(() => nowMs);
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8;
    expect(recording.record()).toBe(true);
    kind.capture(recording, 1, 10, 1500);
    nowMs = 4000;

    expect(recording.stopRecord()).toBeNull();
    expect(added).toEqual([]);
  });

  it('keeps each pass as a take and the last pass on the clip in takes mode', () => {
    const { result, added } = recordTwoPasses('takes');
    expect(result).toBe(1);
    const [input] = added;
    expect(input).toMatchObject({ startPpq: 4, lengthPpq: 4, notes: [] });
    expect(input[kind.field]).toEqual([kind.lane(1, [[0.75, 30]])]);
    expect(input.activeMidiTakeIndex).toBe(1);
    expect(input.midiTakes).toHaveLength(2);
    const [first, second] = input.midiTakes ?? [];
    expect(first).toMatchObject({ name: 'Take 1', notes: [] });
    expect(first[kind.field]).toEqual([
      kind.lane(1, [
        [0.5, 10],
        [1.5, 20],
      ]),
    ]);
    expectOnly(first, kind.field);
    expect(second).toMatchObject({ name: 'Take 2', notes: [] });
    expect(second[kind.field]).toEqual([kind.lane(1, [[0.75, 30]])]);
    expectOnly(second, kind.field);
  });

  it('keeps only the last pass in keep-last mode', () => {
    const { result, added } = recordTwoPasses('keep-last');
    expect(result).toBe(1);
    expect(added[0][kind.field]).toEqual([kind.lane(1, [[0.75, 30]])]);
    expect(added[0].midiTakes).toBeUndefined();
    expectOnly(added[0], kind.field);
  });

  it('folds every pass into the loop in overdub mode', () => {
    const { result, added } = recordTwoPasses('overdub');
    expect(result).toBe(1);
    expect(added[0]).toMatchObject({ startPpq: 4, lengthPpq: 4 });
    expect(added[0][kind.field]).toEqual([
      kind.lane(1, [
        [0.5, 10],
        [0.75, 30],
        [1.5, 20],
      ]),
    ]);
    expect(added[0].midiTakes).toBeUndefined();
  });
});

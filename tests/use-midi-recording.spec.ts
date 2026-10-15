import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useMidiRecording } from '@/composables/useMidiRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { AddRecordedMidiClipInput } from '@/project/commands';
import { addAudioTrack, clearHistory, setTempoSegments } from '@/project/commands';
import { resolveRecordingStartPlan } from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A transport double with a directly writable playhead. */
function makeTransport(playbackLatency = 0, audiblePosition?: number) {
  const isPlaying = ref(false);
  const positionPpq = ref(0);
  const audiblePositionPpq = audiblePosition === undefined ? positionPpq : ref(audiblePosition);
  const play = vi.fn(() => {
    isPlaying.value = true;
    return true;
  });
  const seekPpq = vi.fn((ppq: number) => {
    positionPpq.value = ppq;
    return true;
  });
  const transport: UseTransportReturn = {
    isPlaying,
    positionSeconds: ref(0),
    positionPpq,
    audiblePositionSeconds: ref(0),
    audiblePositionPpq,
    tempo: ref(120),
    loopEnabled: ref(false),
    loopStartPpq: ref(0),
    loopEndPpq: ref(0),
    metronomeEnabled: ref(false),
    playbackLatencySeconds: ref(playbackLatency),
    play,
    stop: vi.fn(() => {
      isPlaying.value = false;
      return true;
    }),
    seek: vi.fn(() => true),
    seekPpq,
    setTempo: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome: vi.fn(() => false),
    dispose: vi.fn(),
  };
  return { transport, isPlaying, positionPpq, audiblePositionPpq, play, seekPpq };
}

/** A recording handle whose clip command records its input instead of editing. */
function setup(
  options: { now?: () => number; playbackLatency?: number; audiblePosition?: number } = {},
) {
  const calls: AddRecordedMidiClipInput[] = [];
  const t = makeTransport(options.playbackLatency, options.audiblePosition);
  const recording = useMidiRecording(t.transport, {
    now: options.now,
    addRecordedMidiClip: (input) => {
      calls.push(input);
      return 1;
    },
  });
  return { ...t, recording, calls };
}

describe('useMidiRecording', () => {
  let store: ReturnType<typeof useProjectStore>;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('captures notes against the transport and commits a clip at the punch-in', () => {
    const { recording, positionPpq, calls, play } = setup();
    recording.arm(store.tracks[0].id);
    expect(recording.record()).toBe(true);
    expect(play).toHaveBeenCalledOnce();

    positionPpq.value = 1;
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0 });
    positionPpq.value = 2;
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
    positionPpq.value = 4;

    const clipId = recording.stopRecord();
    expect(clipId).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      trackId: store.tracks[0].id,
      startPpq: 0,
      lengthPpq: 4,
      notes: [{ pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 }],
    });
    expect(recording.isRecording.value).toBe(false);
  });

  it('starts stopped MIDI recording with a count-in pre-roll', () => {
    const { recording, positionPpq, seekPpq, play, transport } = setup();
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8;

    expect(recording.record()).toBe(true);

    expect(transport.toggleMetronome).toHaveBeenCalledWith(true);
    expect(seekPpq).toHaveBeenCalledWith(4);
    expect(play).toHaveBeenCalledOnce();
    expect(recording.isCountingIn.value).toBe(true);
    expect(recording.stopRecord()).toBeNull();
  });

  it('discards note and expression events that end before count-in punch-in', () => {
    let nowMs = 1000;
    const { recording, positionPpq, calls } = setup({ now: () => nowMs });
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8;
    expect(recording.record()).toBe(true); // punch-in timestamp is 3000 ms

    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 1500 });
    recording.captureControlChange({ controller: 1, value: 64, channel: 0, timeStampMs: 1600 });
    recording.capturePitchBend({ value: 4096, channel: 0, timeStampMs: 1700 });
    recording.captureProgramChange({ program: 12, channel: 0, timeStampMs: 1800 });
    recording.captureChannelPressure({ value: 70, channel: 0, timeStampMs: 1900 });
    recording.capturePolyPressure({
      pitch: 60,
      value: 80,
      channel: 0,
      timeStampMs: 2000,
    });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 2500 });
    nowMs = 4000;

    expect(recording.stopRecord()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('anchors a note held across count-in punch-in at the boundary', () => {
    let nowMs = 1000;
    const { recording, positionPpq, calls } = setup({ now: () => nowMs });
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8;
    expect(recording.record()).toBe(true); // punch-in timestamp is 3000 ms

    recording.captureNoteOn({ pitch: 67, velocity: 100, channel: 2, timeStampMs: 2000 });
    recording.captureNoteOff({ pitch: 67, velocity: 45, channel: 2, timeStampMs: 3500 });
    nowMs = 4000;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 8,
      notes: [{ pitch: 67, velocity: 100, startPpq: 0, durationPpq: 1, channel: 2 }],
    });
  });

  it('walks count-in bars across a 3/4 to 5/8 meter change', () => {
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 5, denominator: 8 },
    ];
    const { recording, positionPpq, seekPpq } = setup();
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8.5;

    expect(recording.record()).toBe(true);
    expect(seekPpq).toHaveBeenCalledWith(6);
  });

  it('times count-in from the tempo map when a tempo change falls inside it', () => {
    vi.useFakeTimers();
    store.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 6, bpm: 60 },
    ];
    const { recording, positionPpq } = setup();
    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    positionPpq.value = 8;

    expect(recording.record()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(recording.isCountingIn.value).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(recording.isCountingIn.value).toBe(false);
    vi.useRealTimers();
  });

  it('clears the count-in timer when its owning scope is stopped', () => {
    vi.useFakeTimers();
    const calls: AddRecordedMidiClipInput[] = [];
    const t = makeTransport();
    let recording: ReturnType<typeof useMidiRecording> | undefined;
    const scope = effectScope();
    scope.run(() => {
      recording = useMidiRecording(t.transport, {
        addRecordedMidiClip: (input) => {
          calls.push(input);
          return 1;
        },
      });
    });
    if (!recording) throw new Error('effect scope did not run');

    recording.arm(store.tracks[0].id);
    recording.countInBars.value = 1;
    t.positionPpq.value = 8;
    expect(recording.record()).toBe(true);
    expect(recording.isCountingIn.value).toBe(true);

    scope.stop();
    expect(recording.isCountingIn.value).toBe(false);
    expect(t.transport.toggleMetronome).toHaveBeenNthCalledWith(1, true);
    expect(t.transport.toggleMetronome).toHaveBeenNthCalledWith(2, false);

    vi.advanceTimersByTime(2000);
    expect(t.transport.toggleMetronome).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it('closes a key still held at the punch-out with an implicit release', () => {
    const { recording, positionPpq, calls } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 1;
    recording.captureNoteOn({ pitch: 67, velocity: 100, channel: 0 });
    positionPpq.value = 5;
    recording.stopRecord();
    expect(calls[0].notes).toEqual([
      { pitch: 67, velocity: 100, startPpq: 1, durationPpq: 4, channel: 0 },
    ]);
  });

  it('keeps held notes across loop wraps by recording monotonic PPQ', () => {
    const { recording, positionPpq, transport, calls } = setup();
    recording.arm(store.tracks[0].id);
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 4;
    transport.loopEndPpq.value = 8;
    positionPpq.value = 4;
    recording.record();

    positionPpq.value = 7.5;
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0 });
    positionPpq.value = 4.5; // transport wrapped to the loop start
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
    positionPpq.value = 5;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 4,
      lengthPpq: 4,
      notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 0.5, channel: 0 }],
    });
  });

  it('offers overdub and keep-last cycle-recording modes', () => {
    const recordTwoPasses = (mode: 'overdub' | 'keep-last') => {
      const setupResult = setup();
      const { recording, positionPpq, transport, calls } = setupResult;
      recording.arm(store.tracks[0].id);
      recording.cycleRecordMode.value = mode;
      transport.loopEnabled.value = true;
      transport.loopStartPpq.value = 4;
      transport.loopEndPpq.value = 8;
      positionPpq.value = 4;
      recording.record();
      positionPpq.value = 4.5;
      recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0 });
      positionPpq.value = 5;
      recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
      positionPpq.value = 4.5;
      recording.captureNoteOn({ pitch: 64, velocity: 90, channel: 0 });
      positionPpq.value = 5;
      recording.captureNoteOff({ pitch: 64, velocity: 0, channel: 0 });
      recording.stopRecord();
      return calls[0];
    };

    const overdub = recordTwoPasses('overdub');
    expect(overdub.notes.map((note) => note.pitch)).toEqual([60, 64]);
    expect(overdub.midiTakes).toBeUndefined();

    const keepLast = recordTwoPasses('keep-last');
    expect(keepLast.notes.map((note) => note.pitch)).toEqual([64]);
    expect(keepLast.midiTakes).toBeUndefined();
  });

  it('closes held notes on the timestamp clock after three or more loop passes', () => {
    let nowMs = 0;
    const { recording, positionPpq, transport, calls } = setup({ now: () => nowMs });
    recording.arm(store.tracks[0].id);
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 4;
    transport.loopEndPpq.value = 8;
    positionPpq.value = 4;
    recording.record();

    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0, timeStampMs: 5000 });
    positionPpq.value = 5;
    nowMs = 6000;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 4,
      lengthPpq: 4,
      notes: [{ pitch: 60, velocity: 96, startPpq: 2, durationPpq: 2, channel: 0 }],
    });
  });

  it('folds timestamped loop passes by the variable-tempo loop duration', () => {
    let nowMs = 0;
    const { recording, positionPpq, transport, calls } = setup({ now: () => nowMs });
    setTempoSegments([
      { startPpq: 0, bpm: 120 },
      { startPpq: 2, bpm: 60 },
    ]);
    recording.arm(store.tracks[0].id);
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 0;
    transport.loopEndPpq.value = 4;
    positionPpq.value = 0;
    recording.record();

    // The 0..4 PPQ loop lasts 3 seconds: 0..2 PPQ at 120 BPM, then
    // 2..4 PPQ at 60 BPM. A note 0.5s into the second pass should fold to
    // local PPQ 1, not drift to the global tempo-map position at 3.5s.
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0, timeStampMs: 3500 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 4000 });
    nowMs = 4000;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 0,
      lengthPpq: 4,
      notes: [{ pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 }],
    });
  });

  it('records CC, pitch bend, program change and pressure lanes with the take', () => {
    const { recording, positionPpq, calls } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();

    positionPpq.value = 1;
    recording.captureControlChange({ controller: 64, value: 127, channel: 0 });
    positionPpq.value = 1.5;
    recording.capturePitchBend({ value: 4096, channel: 0 });
    positionPpq.value = 1.75;
    recording.captureProgramChange({ program: 41, channel: 0 });
    positionPpq.value = 2;
    recording.captureChannelPressure({ value: 70, channel: 0 });
    positionPpq.value = 2.5;
    recording.capturePolyPressure({ pitch: 60, value: 80, channel: 0 });
    positionPpq.value = 4;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
      ccLanes: [{ controller: 64, channel: 0, points: [{ ppq: 1, value: 127 }] }],
      pitchBendLanes: [{ channel: 0, points: [{ ppq: 1.5, value: 4096 }] }],
      programChangeLanes: [{ channel: 0, points: [{ ppq: 1.75, program: 41 }] }],
      channelPressureLanes: [{ channel: 0, points: [{ ppq: 2, value: 70 }] }],
      polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 2.5, value: 80 }] }],
    });
  });

  it('keeps only the final complete pass of recorded expression lanes', () => {
    const { recording, positionPpq, transport, calls } = setup();
    recording.arm(store.tracks[0].id);
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 4;
    transport.loopEndPpq.value = 8;
    positionPpq.value = 4;
    recording.record();

    positionPpq.value = 7.5;
    recording.captureControlChange({ controller: 1, value: 64, channel: 0 });
    positionPpq.value = 4.5;
    recording.capturePitchBend({ value: 8192, channel: 0 });
    positionPpq.value = 5.5;
    recording.captureProgramChange({ program: 12, channel: 0 });
    positionPpq.value = 5;

    expect(recording.stopRecord()).toBe(1);
    expect(calls[0]).toMatchObject({
      startPpq: 4,
      lengthPpq: 4,
      pitchBendLanes: [{ channel: 0, points: [{ ppq: 0.5, value: 8192 }] }],
      programChangeLanes: [{ channel: 0, points: [{ ppq: 1.5, program: 12 }] }],
    });
    expect(calls[0].ccLanes).toBeUndefined();
    expect(calls[0].midiTakes).toMatchObject([
      {
        name: 'Take 1',
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 3.5, value: 64 }] }],
      },
      {
        name: 'Take 2',
        pitchBendLanes: [{ channel: 0, points: [{ ppq: 0.5, value: 8192 }] }],
        programChangeLanes: [{ channel: 0, points: [{ ppq: 1.5, program: 12 }] }],
      },
    ]);
    expect(calls[0].activeMidiTakeIndex).toBe(1);
  });

  it('applies the input-quantize grid to captured note starts', () => {
    const { recording, positionPpq, calls } = setup();
    recording.inputQuantizeDenominator.value = 4; // 1/4-note grid = 1 PPQ
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 1.4;
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0 });
    positionPpq.value = 2.4;
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
    positionPpq.value = 4;
    recording.stopRecord();
    expect(calls[0].notes[0].startPpq).toBe(1);
  });

  it('uses Web MIDI timestamps for sub-frame capture timing', () => {
    const { recording, positionPpq, calls } = setup({ now: () => 1000 });
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 0;
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 1010 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 1035 });
    positionPpq.value = 1;
    recording.stopRecord();

    expect(calls[0].notes[0].startPpq).toBeCloseTo(0.02, 6);
    expect(calls[0].notes[0].durationPpq).toBeCloseTo(0.05, 6);
  });

  it('aligns MIDI timestamps to the audible start when playback begins from rest', () => {
    const { recording, positionPpq, calls } = setup({ now: () => 1000, playbackLatency: 0.05 });
    recording.arm(store.tracks[0].id);
    recording.record();
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 1050 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 1100 });
    positionPpq.value = 1;
    recording.stopRecord();

    expect(calls[0].notes[0]).toMatchObject({ startPpq: 0, durationPpq: 0.1 });
  });

  it('does not add playback latency when punching into an already rolling transport', () => {
    const { recording, positionPpq, isPlaying, calls } = setup({
      now: () => 1000,
      playbackLatency: 0.05,
      audiblePosition: 3.9,
    });
    recording.arm(store.tracks[0].id);
    isPlaying.value = true;
    positionPpq.value = 4;
    recording.record();
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 1010 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 1060 });
    positionPpq.value = 1;
    recording.stopRecord();

    expect(calls[0].startPpq).toBeCloseTo(3.9, 6);
    expect(calls[0].notes[0].startPpq).toBeCloseTo(0.02, 6);
    expect(calls[0].notes[0].durationPpq).toBeCloseTo(0.1, 6);
  });

  it('uses the plan rest snapshot for latency after audio owns transport start', () => {
    let nowMs = 1000;
    const { recording, positionPpq, isPlaying, calls, transport } = setup({
      now: () => nowMs,
      playbackLatency: 0.05,
    });
    recording.arm(store.tracks[0].id);
    const plan = resolveRecordingStartPlan({
      positionPpq: 0,
      audiblePositionPpq: 0,
      startedFromRest: true,
      loopEnabled: false,
      loopStartPpq: 0,
      loopEndPpq: 0,
      countInBars: 0,
      transportOwner: 'audio',
    });
    // The shared audio owner may have turned this live flag on before MIDI
    // consumes the plan. The original rest state still requires latency.
    isPlaying.value = true;
    expect(recording.record(plan)).toBe(true);
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 1050 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 1100 });
    positionPpq.value = 1;
    nowMs = 1200;
    recording.stopRecord();

    expect(transport.play).not.toHaveBeenCalled();
    expect(calls[0].notes[0]).toMatchObject({ startPpq: 0, durationPpq: 0.1 });
  });

  it('anchors explicit punch-in timestamps after a rolling count-in pre-roll', () => {
    const { recording, positionPpq, isPlaying, calls } = setup({ now: () => 1000 });
    recording.arm(store.tracks[0].id);
    isPlaying.value = true;
    positionPpq.value = 4;

    expect(recording.record(8)).toBe(true);

    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0, timeStampMs: 3000 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 3500 });
    positionPpq.value = 10;
    recording.stopRecord();

    expect(calls[0]).toMatchObject({
      startPpq: 8,
      notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
    });
  });

  it('ends an in-flight take when the transport stops', () => {
    const { recording, positionPpq, isPlaying, calls } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 1;
    recording.captureNoteOn({ pitch: 60, velocity: 90, channel: 0 });
    positionPpq.value = 2;
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
    positionPpq.value = 3;
    isPlaying.value = false; // transport stop watcher finalizes the take
    expect(recording.isRecording.value).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does not commit a clip when nothing was captured', () => {
    const { recording, positionPpq, calls } = setup();
    recording.arm(store.tracks[0].id);
    recording.record();
    positionPpq.value = 4;
    expect(recording.stopRecord()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('rejects arming a non-MIDI track and recording without an armed track', () => {
    const { recording } = setup();
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    recording.arm(audioTrackId);
    expect(recording.armedTrackId.value).toBeNull();
    expect(recording.error.value).toMatch(/MIDI track/);

    recording.arm(null);
    expect(recording.record()).toBe(false);
    expect(recording.error.value).toMatch(/Arm a MIDI track/);
  });
});

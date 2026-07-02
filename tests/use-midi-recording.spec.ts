import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useMidiRecording } from '@/composables/useMidiRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { AddRecordedMidiClipInput } from '@/project/commands';
import { addAudioTrack, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A transport double with a directly writable playhead. */
function makeTransport() {
  const isPlaying = ref(false);
  const positionPpq = ref(0);
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
    tempo: ref(120),
    loopEnabled: ref(false),
    loopStartPpq: ref(0),
    loopEndPpq: ref(0),
    metronomeEnabled: ref(false),
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
  return { transport, isPlaying, positionPpq, play, seekPpq };
}

/** A recording handle whose clip command records its input instead of editing. */
function setup(options: { now?: () => number } = {}) {
  const calls: AddRecordedMidiClipInput[] = [];
  const t = makeTransport();
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
      notes: [
        { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 0.5, channel: 0 },
        { pitch: 60, velocity: 96, startPpq: 3.5, durationPpq: 0.5, channel: 0 },
      ],
    });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref } from 'vue';

const handleCc = vi.fn();
const webMidiConnect = vi.fn(async () => true);
const webMidiDisconnect = vi.fn();
const surfaceRefresh = vi.fn(async () => true);
let webMidiOptions: Parameters<typeof import('@/composables/useWebMidi').useWebMidi>[0] | null =
  null;
let musicTypingOptions:
  | Parameters<typeof import('@/composables/useMusicTyping').useMusicTyping>[0]
  | null = null;

vi.mock('@/composables/useMidiLearn', () => ({
  useMidiLearn: () => ({ handleCc }),
  MIDI_LEARN_KEY: Symbol('midi-learn'),
}));

vi.mock('@/composables/useMusicTyping', () => ({
  useMusicTyping: (
    options: Parameters<typeof import('@/composables/useMusicTyping').useMusicTyping>[0],
  ) => {
    musicTypingOptions = options;
    return { enabled: ref(false), enable: vi.fn(), disable: vi.fn() };
  },
}));

vi.mock('@/composables/useControlSurface', () => ({
  useControlSurface: () => ({
    available: ref(null),
    inputs: ref([]),
    outputs: ref([]),
    error: ref<string | null>(null),
    connected: ref(false),
    excludedInputIds: computed(() => []),
    refresh: surfaceRefresh,
    handleMessage: vi.fn(),
    refreshFeedback: vi.fn(),
  }),
}));

vi.mock('@/composables/useWebMidi', () => ({
  useWebMidi: (options: Parameters<typeof import('@/composables/useWebMidi').useWebMidi>[0]) => {
    webMidiOptions = options;
    return {
      available: ref(null),
      inputs: ref([]),
      selectedInputId: ref<string | null>(null),
      excludedInputIds: ref<readonly string[]>([]),
      connected: ref(false),
      error: ref<string | null>(null),
      connect: webMidiConnect,
      disconnect: webMidiDisconnect,
    };
  },
}));

import { useInputControls } from '@/composables/useInputControls';

/** RealtimeEngine stand-in tracking destroy() calls. */
class FakeRealtimeEngine {
  static instances: FakeRealtimeEngine[] = [];
  destroyed = false;
  constructor() {
    FakeRealtimeEngine.instances.push(this);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function makeOptions() {
  return {
    errorMessage: ref(''),
    positionPpq: ref(0),
    stepInput: {
      armed: ref(false),
      arm: vi.fn(),
      disarm: vi.fn(),
      enterNote: vi.fn(),
    } as unknown as Parameters<typeof useInputControls>[0]['stepInput'],
    ensureWasm: async () => ({ RealtimeEngine: FakeRealtimeEngine as never }),
    previewNote: vi.fn(async () => {}),
    previewNoteOn: vi.fn(async () => {}),
    previewNoteOff: vi.fn(),
    previewChannelVoice: vi.fn(async () => {}),
    runAction: (action: () => Promise<void>) => action(),
  };
}

beforeEach(() => {
  FakeRealtimeEngine.instances = [];
  webMidiOptions = null;
  musicTypingOptions = null;
  handleCc.mockClear();
  webMidiConnect.mockClear();
  webMidiDisconnect.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInputControls MIDI routing engine lifecycle', () => {
  it('destroys the routing engine and disconnects Web MIDI when the scope disposes', async () => {
    const scope = effectScope();
    let controls!: ReturnType<typeof useInputControls>;
    scope.run(() => {
      controls = useInputControls(makeOptions());
    });

    await controls.connectWebMidi();
    expect(FakeRealtimeEngine.instances).toHaveLength(1);
    expect(webMidiConnect).toHaveBeenCalledWith(FakeRealtimeEngine.instances[0]);
    expect(FakeRealtimeEngine.instances[0].destroyed).toBe(false);

    scope.stop();
    expect(FakeRealtimeEngine.instances[0].destroyed).toBe(true);
    expect(webMidiDisconnect).toHaveBeenCalledTimes(1);
  });

  it('reuses one routing engine across repeated connects', async () => {
    const scope = effectScope();
    let controls!: ReturnType<typeof useInputControls>;
    scope.run(() => {
      controls = useInputControls(makeOptions());
    });

    await controls.connectWebMidi();
    await controls.connectWebMidi();
    expect(FakeRealtimeEngine.instances).toHaveLength(1);
    scope.stop();
  });

  it('routes Web MIDI expression events into recording callbacks', () => {
    const onRecordControlChange = vi.fn();
    const onRecordPitchBend = vi.fn();
    const onRecordProgramChange = vi.fn();
    const onRecordChannelPressure = vi.fn();
    const onRecordPolyPressure = vi.fn();
    const options = makeOptions();
    const scope = effectScope();
    scope.run(() => {
      useInputControls({
        ...options,
        onRecordControlChange,
        onRecordPitchBend,
        onRecordProgramChange,
        onRecordChannelPressure,
        onRecordPolyPressure,
      });
    });

    webMidiOptions?.onControlChange?.({
      controller: 64,
      value: 127,
      channel: 1,
      timeStampMs: 123,
    });
    webMidiOptions?.onPitchBend?.({ value: 4096, channel: 1, timeStampMs: 124 });
    webMidiOptions?.onProgramChange?.({ program: 10, channel: 1, timeStampMs: 125 });
    webMidiOptions?.onChannelPressure?.({ value: 70, channel: 1, timeStampMs: 126 });
    webMidiOptions?.onPolyPressure?.({ pitch: 60, value: 80, channel: 1, timeStampMs: 127 });

    expect(handleCc).toHaveBeenCalledWith({
      controller: 64,
      value: 127,
      channel: 1,
      timeStampMs: 123,
    });
    expect(onRecordControlChange).toHaveBeenCalledWith({
      controller: 64,
      value: 127,
      channel: 1,
      timeStampMs: 123,
    });
    expect(onRecordPitchBend).toHaveBeenCalledWith({ value: 4096, channel: 1, timeStampMs: 124 });
    expect(onRecordProgramChange).toHaveBeenCalledWith({
      program: 10,
      channel: 1,
      timeStampMs: 125,
    });
    expect(onRecordChannelPressure).toHaveBeenCalledWith({
      value: 70,
      channel: 1,
      timeStampMs: 126,
    });
    expect(onRecordPolyPressure).toHaveBeenCalledWith({
      pitch: 60,
      value: 80,
      channel: 1,
      timeStampMs: 127,
    });
    expect(options.previewChannelVoice.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'cc', controller: 64, value: 127, channel: 1, timeStampMs: 123 },
      { kind: 'pitch-bend', value: 4096, channel: 1, timeStampMs: 124 },
      { kind: 'program-change', program: 10, channel: 1, timeStampMs: 125 },
      { kind: 'channel-pressure', value: 70, channel: 1, timeStampMs: 126 },
      { kind: 'poly-pressure', pitch: 60, value: 80, channel: 1, timeStampMs: 127 },
    ]);
    scope.stop();
  });

  it('uses sustained audible note-on/off for live Web MIDI keys', () => {
    const options = makeOptions();
    const onRecordNoteOn = vi.fn();
    const onRecordNoteOff = vi.fn();
    const scope = effectScope();
    scope.run(() => {
      useInputControls({
        ...options,
        onRecordNoteOn,
        onRecordNoteOff,
      });
    });

    webMidiOptions?.onNoteOn?.({ pitch: 60, velocity: 96, channel: 2, timeStampMs: 10 });
    webMidiOptions?.onNoteOff?.({ pitch: 60, velocity: 64, channel: 2, timeStampMs: 20 });

    expect(options.previewNote).not.toHaveBeenCalled();
    expect(options.previewNoteOn).toHaveBeenCalledWith(60, 96, 2, 10);
    expect(options.stepInput.enterNote).toHaveBeenCalledWith(60, 96);
    expect(onRecordNoteOn).toHaveBeenCalledWith({
      pitch: 60,
      velocity: 96,
      channel: 2,
      timeStampMs: 10,
    });
    expect(options.previewNoteOff).toHaveBeenCalledWith(60, 2, 64, 20);
    expect(onRecordNoteOff).toHaveBeenCalledWith({
      pitch: 60,
      velocity: 64,
      channel: 2,
      timeStampMs: 20,
    });
    scope.stop();
  });

  it('suppresses step input for a live note while a recording take is capturing', () => {
    const options = makeOptions();
    const onRecordNoteOn = vi.fn();
    const recordingActive = ref(true);
    const scope = effectScope();
    scope.run(() => {
      useInputControls({ ...options, recordingActive, onRecordNoteOn });
    });

    // Capturing: the note is recorded, but NOT also step-entered (no double input).
    webMidiOptions?.onNoteOn?.({ pitch: 60, velocity: 96, channel: 2, timeStampMs: 10 });
    expect(onRecordNoteOn).toHaveBeenCalledTimes(1);
    expect(options.stepInput.enterNote).not.toHaveBeenCalled();

    // Not capturing: step input resumes for live notes.
    recordingActive.value = false;
    webMidiOptions?.onNoteOn?.({ pitch: 62, velocity: 80, channel: 2, timeStampMs: 20 });
    expect(options.stepInput.enterNote).toHaveBeenCalledWith(62, 80);
    scope.stop();
  });

  it('uses sustained audible note-on/off for QWERTY music typing', () => {
    const options = makeOptions();
    const scope = effectScope();
    scope.run(() => useInputControls(options));

    musicTypingOptions?.onNoteOn?.({ pitch: 64, velocity: 88 });
    musicTypingOptions?.onNoteOff?.({ pitch: 64 });

    expect(options.previewNote).not.toHaveBeenCalled();
    expect(options.previewNoteOn).toHaveBeenCalledWith(64, 88);
    expect(options.previewNoteOff).toHaveBeenCalledWith(64);
    scope.stop();
  });
});

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, shallowRef } from 'vue';
import { useNotePreview } from '@/composables/useNotePreview';
import type { EngineHandle } from '@/engine/engine';
import { addTrack, clearHistory, setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A minimal engine handle exposing only the live-MIDI facade used by sustain. */
function makeHandle() {
  const pushMidiNoteOn = vi.fn();
  const pushMidiNoteOff = vi.fn();
  const pushMidiCc = vi.fn();
  const handle = shallowRef<EngineHandle | null>({
    engine: { pushMidiNoteOn, pushMidiNoteOff, pushMidiCc },
    ctx: { sampleRate: 48000 },
  } as unknown as EngineHandle);
  return { handle, pushMidiNoteOn, pushMidiNoteOff, pushMidiCc };
}

describe('useNotePreview live MIDI sustain', () => {
  let store: ReturnType<typeof useProjectStore>;
  let midiTrackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    midiTrackId = addTrack({ name: 'Synth' });
    setActiveTrack(midiTrackId);
  });

  function setup() {
    const { handle, pushMidiNoteOn, pushMidiNoteOff, pushMidiCc } = makeHandle();
    const errorMessage = shallowRef('');
    const preview = useNotePreview({
      errorMessage,
      handle,
      hasMidiSync: () => true,
      ensureEngineStarted: async () => handle.value,
    });
    return { preview, handle, pushMidiNoteOn, pushMidiNoteOff, pushMidiCc, errorMessage };
  }

  it('sustains a held note: note-on rings without an auto-scheduled note-off', async () => {
    const { preview, pushMidiNoteOn, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 100);

    expect(pushMidiNoteOn).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOn).toHaveBeenCalledWith(midiTrackId, 0, 0, 64, 100);
    // The key is still down: nothing released it yet (no fixed-length blip).
    expect(pushMidiNoteOff).not.toHaveBeenCalled();
  });

  it('releases the matching note on key-up', async () => {
    const { preview, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 100);
    preview.previewNoteOff(64);

    expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
  });

  it('a stray key-up for a note that is not held is a no-op', () => {
    const { preview, pushMidiNoteOff } = setup();
    preview.previewNoteOff(70);
    expect(pushMidiNoteOff).not.toHaveBeenCalled();
  });

  it('retriggering the same pitch releases the previous note first', async () => {
    const { preview, pushMidiNoteOn, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 80);
    await preview.previewNoteOn(64, 110);

    // Second press releases the still-held note before sounding the new one.
    expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
    expect(pushMidiNoteOn).toHaveBeenCalledTimes(2);
    expect(pushMidiNoteOn).toHaveBeenLastCalledWith(midiTrackId, 0, 0, 64, 110);
  });

  it('releaseAll releases every held note', async () => {
    const { preview, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(60, 90);
    await preview.previewNoteOn(64, 90);
    await preview.previewNoteOn(67, 90);
    preview.releaseAll();

    expect(pushMidiNoteOff).toHaveBeenCalledTimes(3);
    expect(pushMidiNoteOff.mock.calls.map((c) => c[3]).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it('holds the same pitch independently on two MIDI channels', async () => {
    const { preview, pushMidiNoteOn, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(60, 90, 2);
    await preview.previewNoteOn(60, 100, 7);

    expect(pushMidiNoteOn).toHaveBeenNthCalledWith(1, midiTrackId, 0, 2, 60, 90);
    expect(pushMidiNoteOn).toHaveBeenNthCalledWith(2, midiTrackId, 0, 7, 60, 100);
    preview.previewNoteOff(60, 2);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 2, 60);
    preview.previewNoteOff(60, 7);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 7, 60);
  });

  it('routes every external channel-voice family with input timestamps', async () => {
    const { handle, pushMidiNoteOn, pushMidiCc } = makeHandle();
    const sendLiveExternalMidi = vi.fn(() => true);
    const preview = useNotePreview({
      errorMessage: shallowRef(''),
      handle,
      hasMidiSync: () => true,
      ensureEngineStarted: async () => handle.value,
      sendLiveExternalMidi,
    });

    await preview.previewNoteOn(60, 100, 3, 1000);
    await preview.previewChannelVoice({
      kind: 'cc',
      controller: 64,
      value: 127,
      channel: 3,
      timeStampMs: 1001,
    });
    await preview.previewChannelVoice({
      kind: 'pitch-bend',
      value: 12288,
      channel: 3,
      timeStampMs: 1002,
    });
    await preview.previewChannelVoice({
      kind: 'program-change',
      program: 41,
      channel: 3,
      timeStampMs: 1003,
    });
    await preview.previewChannelVoice({
      kind: 'channel-pressure',
      value: 70,
      channel: 3,
      timeStampMs: 1004,
    });
    await preview.previewChannelVoice({
      kind: 'poly-pressure',
      pitch: 60,
      value: 80,
      channel: 3,
      timeStampMs: 1005,
    });
    preview.previewNoteOff(60, 3, 45, 1006);

    expect(sendLiveExternalMidi.mock.calls).toEqual([
      [midiTrackId, [0x93, 60, 100], 1000],
      [midiTrackId, [0xb3, 64, 127], 1001],
      [midiTrackId, [0xe3, 0, 96], 1002],
      [midiTrackId, [0xc3, 41], 1003],
      [midiTrackId, [0xd3, 70], 1004],
      [midiTrackId, [0xa3, 60, 80], 1005],
      [midiTrackId, [0x83, 60, 45], 1006],
    ]);
    expect(pushMidiNoteOn).not.toHaveBeenCalled();
    expect(pushMidiCc).not.toHaveBeenCalled();
  });

  it('routes sustain CC through the internal realtime engine when no external route exists', async () => {
    const { preview, pushMidiCc } = setup();
    await preview.previewChannelVoice({ kind: 'cc', controller: 64, value: 127, channel: 4 });
    expect(pushMidiCc).toHaveBeenCalledWith(midiTrackId, 0, 4, 64, 127);
  });

  it('auto-releases a held note after the safety timeout if the key-up is lost', async () => {
    vi.useFakeTimers();
    try {
      const { preview, pushMidiNoteOff } = setup();
      await preview.previewNoteOn(64, 100);
      expect(pushMidiNoteOff).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10000);
      expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releaseAll clears pending fixed-duration MIDI auditions without duplicate note-off', async () => {
    vi.useFakeTimers();
    try {
      const { preview, pushMidiNoteOff } = setup();
      await preview.previewNote(64, 100);
      expect(pushMidiNoteOff).not.toHaveBeenCalled();

      preview.releaseAll();
      expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
      expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);

      vi.advanceTimersByTime(250);
      expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scope disposal releases held notes and pending fixed-duration auditions', async () => {
    vi.useFakeTimers();
    try {
      const { handle, pushMidiNoteOff } = makeHandle();
      const errorMessage = shallowRef('');
      const scope = effectScope();
      const preview = scope.run(() =>
        useNotePreview({
          errorMessage,
          handle,
          hasMidiSync: () => true,
          ensureEngineStarted: async () => handle.value,
        }),
      );
      if (!preview) throw new Error('effect scope did not run');

      await preview.previewNoteOn(60, 100);
      await preview.previewNote(64, 100);
      scope.stop();

      expect(pushMidiNoteOff).toHaveBeenCalledTimes(2);
      expect(pushMidiNoteOff.mock.calls.map((call) => call[3]).sort((a, b) => a - b)).toEqual([
        60, 64,
      ]);
      vi.advanceTimersByTime(10000);
      expect(pushMidiNoteOff).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

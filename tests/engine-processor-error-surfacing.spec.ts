import { describe, expect, it, vi } from 'vitest';
import { listenProcessorError } from '@/engine/engine';
import { createMidiSync } from '@/engine/midi-sync';
import { createRecorder } from '@/engine/recorder';
import type { EditorClip, EditorTrack } from '@/project/types';
import { fakeEngineHandle } from './fakes/engine';

function makeStream() {
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const tracks = [track] as unknown as MediaStreamTrack[];
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

describe('listenProcessorError', () => {
  it('fires once across several nodes and detaches', () => {
    const target = new EventTarget();
    const other = new EventTarget();
    const onError = vi.fn();
    const detach = listenProcessorError([target, other], onError);
    target.dispatchEvent(new Event('processorerror'));
    other.dispatchEvent(new Event('processorerror'));
    expect(onError).toHaveBeenCalledTimes(1);
    detach();
    const again = vi.fn();
    const detachAgain = listenProcessorError([target], again);
    detachAgain();
    target.dispatchEvent(new Event('processorerror'));
    expect(again).not.toHaveBeenCalled();
  });
});

describe('recorder input processor crash', () => {
  it('tears down the binding and notifies onInputProcessorError, not onMicrophoneLost', async () => {
    const handle = fakeEngineHandle({
      engine: {
        node: {},
        configureCapture: vi.fn(),
        resetCapture: vi.fn(async () => {}),
        onMeter: vi.fn(() => () => {}),
      },
      ctx: { sampleRate: 100, baseLatency: 0 },
    });
    const destroy = vi.fn();
    let crash: (() => void) | undefined;
    const recorder = createRecorder(handle, {
      getUserMedia: async () => makeStream(),
      bindInput: async (_ctx, _node, opts) => {
        crash = opts.onProcessorError;
        return { stream: opts.stream, source: {} as AudioNode, destroy };
      },
    });
    const crashed = vi.fn();
    const lost = vi.fn();
    recorder.onInputProcessorError(crashed);
    recorder.onMicrophoneLost(lost);
    await recorder.requestMicrophone();
    expect(recorder.hasMicrophone()).toBe(true);

    crash?.();

    expect(crashed).toHaveBeenCalledTimes(1);
    expect(lost).not.toHaveBeenCalled();
    expect(recorder.hasMicrophone()).toBe(false);
    expect(destroy).toHaveBeenCalled();
  });
});

describe('midi sync unapplied GS setup', () => {
  it('reports unsupported SysEx packets once per change', async () => {
    const engine = {
      setMidiClips: vi.fn(),
      pushMidiUmp: vi.fn(),
      setSynthInstrument: vi.fn(),
      loadSoundFont: vi.fn(),
      setSf2Instrument: vi.fn(),
      pushMidiSysex: vi.fn(),
      clearMidiFx: vi.fn(),
      setMidiFx: vi.fn(),
      setMidiDestinationExternal: vi.fn(),
      setExternalMidiClockEnabled: vi.fn(),
    };
    const handle = fakeEngineHandle({ ctx: { sampleRate: 48000 }, engine });
    const onGsSetupUnapplied = vi.fn();
    const sync = createMidiSync(handle, {
      loadFont: async () => new Uint8Array([1]),
      onGsSetupUnapplied,
    });
    const track = {
      id: 1,
      name: 'T1',
      kind: 'midi',
      instrument: { kind: 'sf2', fontId: 'font' },
    } as unknown as EditorTrack;
    const clip = {
      id: 1,
      trackId: 1,
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
      smfSysEx: [{ ppq: 2, status: 0xf0, data: [0x41, 0xf7] }],
    } as unknown as EditorClip;
    const tempo = [{ startPpq: 0, bpm: 120 }];

    await sync.sync([track], [clip], tempo);
    await sync.sync([track], [clip], tempo);

    expect(onGsSetupUnapplied).toHaveBeenCalledTimes(1);
    expect(onGsSetupUnapplied).toHaveBeenCalledWith(1);
  });
});

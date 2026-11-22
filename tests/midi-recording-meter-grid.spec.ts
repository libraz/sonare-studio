import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMidiRecording } from '@/composables/useMidiRecording';
import { useTransport } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import type { AddRecordedMidiClipInput } from '@/project/command/midi-recording';
import { clearHistory, setTimeSignatures } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { SonareEngine } from '@/wasm/worklet.js';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Engine handle whose transport accepts every command. */
function fakeEngineHandle(): EngineHandle {
  const ok = () => undefined;
  return {
    engine: {
      transport: {
        play: ok,
        stop: ok,
        seekPpq: ok,
        seekSec: ok,
        setLoop: ok,
      } satisfies Partial<SonareEngine['transport']>,
      setMetronome: ok,
      pushMidiPanic: () => {},
      pollTelemetry: () => [],
      onTelemetry: () => () => {},
    },
    ctx: { sampleRate: 48000, baseLatency: 0, outputLatency: 0, state: 'running' },
  } as unknown as EngineHandle;
}

describe('MIDI input quantize on the project meter grid', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('snaps to the bar-anchored swing grid of the meter map, not one measured from the punch', () => {
    const store = useProjectStore();
    // 5/8 bars are 2.5 PPQ, so the second bar starts at 2.5 and its first 1/8 off-beat is 3.0.
    setTimeSignatures([{ startPpq: 0, numerator: 5, denominator: 8 }]);
    store.quantizeSwing = 100;
    const handle = fakeEngineHandle();
    const transport = useTransport(() => handle);
    const calls: AddRecordedMidiClipInput[] = [];
    const recording = useMidiRecording(transport, {
      addRecordedMidiClip: (input) => {
        calls.push(input);
        return 1;
      },
    });
    recording.inputQuantizeDenominator.value = 8;
    recording.arm(store.tracks[0].id);
    transport.seekPpq(2.6);
    expect(recording.record()).toBe(true);

    transport.audiblePositionPpq.value = 3.17;
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0 });
    transport.audiblePositionPpq.value = 3.6;
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
    transport.audiblePositionPpq.value = 4;
    recording.stopRecord();
    transport.dispose();

    // Off-beat 3.0 swung by a third of an eighth, stored relative to the punch at 2.6.
    expect(calls[0].startPpq).toBe(2.6);
    expect(calls[0].notes[0].startPpq).toBeCloseTo(3 + 0.5 / 3 - 2.6, 9);
  });
});

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useMidiRecording } from '@/composables/useMidiRecording';
import type { AddRecordedMidiClipInput } from '@/project/commands';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { fakeTransport } from './fakes/composables';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MIDI recording clip names', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('number only the takes that produced a clip', () => {
    const isPlaying = ref(false);
    const positionPpq = ref(0);
    const transport = fakeTransport({
      isPlaying,
      positionPpq,
      audiblePositionPpq: positionPpq,
      playbackLatencySeconds: ref(0),
      play: () => {
        isPlaying.value = true;
        return true;
      },
      stop: () => {
        isPlaying.value = false;
        return true;
      },
      seekPpq: (ppq: number) => {
        positionPpq.value = ppq;
        return true;
      },
    });
    let failNext = false;
    const names: string[] = [];
    const recording = useMidiRecording(transport, {
      addRecordedMidiClip: (input: AddRecordedMidiClipInput) => {
        if (failNext) {
          failNext = false;
          throw new Error('store refused');
        }
        names.push(input.name ?? '');
        return names.length;
      },
    });
    const take = (withNote: boolean): void => {
      positionPpq.value = 0;
      recording.arm(store.tracks[0].id);
      recording.record();
      if (withNote) {
        positionPpq.value = 1;
        recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0 });
        positionPpq.value = 2;
        recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0 });
      }
      positionPpq.value = 4;
      recording.stopRecord();
      isPlaying.value = false;
    };

    take(true);
    take(false);
    failNext = true;
    take(true);
    take(true);
    expect(names).toEqual(['MIDI Recording 1', 'MIDI Recording 2']);
  });
});

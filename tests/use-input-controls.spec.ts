import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const handleCc = vi.fn();
const webMidiConnect = vi.fn(async () => true);
const webMidiDisconnect = vi.fn();

vi.mock('@/composables/useMidiLearn', () => ({
  useMidiLearn: () => ({ handleCc }),
  MIDI_LEARN_KEY: Symbol('midi-learn'),
}));

vi.mock('@/composables/useMusicTyping', () => ({
  useMusicTyping: () => ({ enabled: ref(false), enable: vi.fn(), disable: vi.fn() }),
}));

vi.mock('@/composables/useWebMidi', () => ({
  useWebMidi: () => ({
    available: ref(null),
    inputs: ref([]),
    selectedInputId: ref<string | null>(null),
    connected: ref(false),
    error: ref<string | null>(null),
    connect: webMidiConnect,
    disconnect: webMidiDisconnect,
  }),
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
    runAction: (action: () => Promise<void>) => action(),
  };
}

beforeEach(() => {
  FakeRealtimeEngine.instances = [];
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
});

import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, type Ref, ref } from 'vue';
import type { ControlSurfaceHandle } from '@/composables/useControlSurface';
import { useControlSurface } from '@/composables/useControlSurface';
import { useMidiLearn } from '@/composables/useMidiLearn';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { SILENCE_DB } from '@/lib/db';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { ccToGainDbFine } from '@/ui/midi/midi-learn';
import { surfaceResetFeedback } from '@/ui/midi/surface-feedback';
import { encodeSurfaceFeedback } from '@/ui/midi/surface-protocol';
import { fakeMeterSource } from './fakes/engine';

const setStripGain = vi.fn();
const setStripPan = vi.fn();
const setTrackMute = vi.fn();
const setTrackSolo = vi.fn();

vi.mock('@/project/commands', () => ({
  setStripGain: (...args: unknown[]) => setStripGain(...args),
  setStripPan: (...args: unknown[]) => setStripPan(...args),
  setTrackMute: (...args: unknown[]) => setTrackMute(...args),
  setTrackSolo: (...args: unknown[]) => setTrackSolo(...args),
  setStripEq: vi.fn(),
  setMasteringParam: vi.fn(),
  setStripInputTrim: vi.fn(),
  setStripWidth: vi.fn(),
  setStripChannelDelaySamples: vi.fn(),
  setStripDualPan: vi.fn(),
  setStripPolarityInvert: vi.fn(),
  setStripPanLaw: vi.fn(),
  setStripPanMode: vi.fn(),
  setVcaGroupGain: vi.fn(),
  setVcaGroupMute: vi.fn(),
  setVcaGroupSolo: vi.fn(),
  setSend: vi.fn(),
  setMidiCcBinding: vi.fn(),
  clearMidiCcBinding: vi.fn(),
  clearAllMidiCcBindings: vi.fn(),
}));

vi.mock('@/project/quick-controls', () => ({
  listQuickControls: vi.fn(() => []),
  setQuickControl: vi.fn(),
}));

/** Captures everything written to the surface's output port. */
const sent: number[][] = [];

interface FakeInput {
  id: string;
  name: string;
  onmidimessage: ((event: { data?: Uint8Array | null }) => void) | null;
}

let input: FakeInput;
let sysexRequested: boolean | undefined;

function installFakeMidi(): void {
  input = { id: 'surface-in', name: 'MCU', onmidimessage: null };
  const output = {
    id: 'surface-out',
    name: 'MCU',
    send: (data: number[]) => {
      sent.push([...data]);
    },
  };
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map([[output.id, output]]),
    onstatechange: null,
  };
  (navigator as unknown as Record<string, unknown>).requestMIDIAccess = (opts?: {
    sysex?: boolean;
  }) => {
    sysexRequested = opts?.sysex;
    return Promise.resolve(access);
  };
}

function trackList(count: number): EditorTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    name: `Track ${index + 1}`,
    color: '#60a5fa',
    kind: 'midi' as const,
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: index,
    mixer: { gainDb: 0, pan: 0, inserts: [], sends: [] },
  }));
}

function mutableMeterSource(levels: Partial<StereoMeterLevels> = {}): {
  source: MeterSource;
  emit: (next: Partial<StereoMeterLevels>) => void;
  unsubscribeCount: () => number;
} {
  let latest: StereoMeterLevels = {
    frame: 0,
    peakDbL: SILENCE_DB,
    peakDbR: SILENCE_DB,
    rmsDbL: SILENCE_DB,
    rmsDbR: SILENCE_DB,
    correlation: 0,
    ...levels,
  };
  const listeners = new Set<(value: StereoMeterLevels) => void>();
  let unsubscribed = 0;
  return {
    source: {
      ...fakeMeterSource(),
      get latest() {
        return latest;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          unsubscribed += 1;
          listeners.delete(listener);
        };
      },
    },
    emit(next) {
      latest = { ...latest, ...next };
      for (const listener of listeners) listener(latest);
    },
    unsubscribeCount: () => unsubscribed,
  };
}

/** Sends raw bytes to the surface as if the port had delivered them. */
function fromSurface(bytes: number[]): void {
  input.onmidimessage?.({ data: new Uint8Array(bytes) });
}

let scope: ReturnType<typeof effectScope>;
let frames: Array<FrameRequestCallback | null>;

/** Runs the animation-frame callbacks queued so far. */
function flushFrame(): void {
  const queued = frames;
  frames = [];
  for (const callback of queued) callback?.(0);
}

/** Builds a configured surface handle inside its own effect scope. */
async function mountSurface(
  overrides: Partial<ReturnType<typeof useProjectStore>['controlSurface']> = {},
  options: {
    isPlaying?: Ref<boolean>;
    trackMeterSource?: (trackId: number) => MeterSource | null;
  } = {},
): Promise<ControlSurfaceHandle> {
  const store = useProjectStore();
  store.tracks = trackList(10);
  store.controlSurface = {
    protocol: 'mcu',
    bankSize: 8,
    bankOffset: 0,
    inputPortId: 'surface-in',
    outputPortId: 'surface-out',
    feedback: true,
    ...overrides,
  };
  scope = effectScope();
  const handle = scope.run(() =>
    useControlSurface({
      learn: useMidiLearn(),
      isPlaying: options.isPlaying,
      trackMeterSource: options.trackMeterSource,
    }),
  );
  if (!handle) throw new Error('effect scope did not run');
  await handle.refresh();
  await nextTick();
  return handle;
}

beforeEach(() => {
  setActivePinia(createPinia());
  sent.length = 0;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames[id - 1] = null;
  });
  sysexRequested = undefined;
  setStripGain.mockReset();
  setStripPan.mockReset();
  setTrackMute.mockReset();
  setTrackSolo.mockReset();
  installFakeMidi();
});

afterEach(() => {
  scope?.stop();
  vi.unstubAllGlobals();
});

describe('control surface input', () => {
  it('drives the track under a slot from a motor fader', async () => {
    await mountSurface();

    // Pitch bend on channel 2 = the third strip, at full travel.
    fromSurface([0xe2, 0x7f, 0x7f]);

    expect(setStripGain).toHaveBeenCalledWith(102, ccToGainDbFine(127), { commit: false });
  });

  it('keeps a 14-bit fader position instead of quantizing to 7 bits', async () => {
    await mountSurface();

    // 8191 of 16383 sits halfway between two 7-bit steps. Snapping it would
    // make the echoed position nudge the motor fader away from the user's hand.
    fromSurface([0xe0, 0x7f, 0x3f]);

    const [, gainDb] = setStripGain.mock.calls[0] as [number, number];
    expect(gainDb).not.toBe(ccToGainDbFine(63));
    expect(gainDb).toBeCloseTo(ccToGainDbFine((8191 / 16383) * 127), 10);
  });

  it('toggles mute from a momentary strip button', async () => {
    const store = useProjectStore();
    await mountSurface();

    fromSurface([0x90, 17, 127]);
    expect(setTrackMute).toHaveBeenCalledWith(101, true);

    // The release must not toggle back, and a second press must turn it off.
    setTrackMute.mockClear();
    fromSurface([0x90, 17, 0]);
    expect(setTrackMute).not.toHaveBeenCalled();

    store.tracks = store.tracks.map((track) =>
      track.id === 101 ? { ...track, mute: true } : track,
    );
    fromSurface([0x90, 17, 127]);
    expect(setTrackMute).toHaveBeenCalledWith(101, false);
  });

  it('pages the bank from the surface bank buttons', async () => {
    const store = useProjectStore();
    await mountSurface();

    fromSurface([0x90, 47, 127]);
    expect(store.controlSurface.bankOffset).toBe(2);

    fromSurface([0x90, 46, 127]);
    expect(store.controlSurface.bankOffset).toBe(0);

    // CHANNEL right nudges by a single track rather than a whole bank.
    fromSurface([0x90, 49, 127]);
    expect(store.controlSurface.bankOffset).toBe(1);
  });

  it('routes transport buttons to the session handlers', async () => {
    const play = vi.fn();
    const store = useProjectStore();
    store.tracks = trackList(4);
    store.controlSurface = {
      protocol: 'mcu',
      bankSize: 8,
      bankOffset: 0,
      inputPortId: 'surface-in',
      outputPortId: 'surface-out',
      feedback: false,
    };
    scope = effectScope();
    const handle = scope.run(() =>
      useControlSurface({ learn: useMidiLearn(), transport: { play } }),
    );
    await handle?.refresh();

    fromSurface([0x90, 94, 127]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('ignores the surface entirely while no protocol is selected', async () => {
    await mountSurface({ protocol: 'none' });

    fromSurface([0xe2, 0x7f, 0x7f]);

    expect(setStripGain).not.toHaveBeenCalled();
  });
});

describe('control surface feedback', () => {
  it('mirrors the full state once the surface attaches', async () => {
    await mountSurface();

    // Eight motor faders plus the master, sent as pitch bend.
    expect(sent.filter((message) => (message[0] & 0xf0) === 0xe0)).toHaveLength(9);
    // Every lamp is addressed so the surface does not keep stale LEDs lit.
    expect(sent).toContainEqual([0x90, 16, 0]);
  });

  it('sends only what changed afterwards', async () => {
    const store = useProjectStore();
    await mountSurface();
    sent.length = 0;

    store.tracks = store.tracks.map((track) =>
      track.id === 100 ? { ...track, solo: true } : track,
    );
    await nextTick();

    expect(sent).toEqual([[0x90, 8, 127]]);
  });

  it('refreshes every strip when the bank window moves', async () => {
    const store = useProjectStore();
    await mountSurface();
    sent.length = 0;

    store.controlSurface = { ...store.controlSurface, bankOffset: 2 };
    await nextTick();

    // The strips now show other tracks, so their previous positions say nothing
    // about what the surface should display.
    expect(sent.filter((message) => (message[0] & 0xf0) === 0xe0)).toHaveLength(9);
  });

  it('stays silent when feedback is switched off', async () => {
    const store = useProjectStore();
    await mountSurface({ feedback: false });
    sent.length = 0;

    store.tracks = store.tracks.map((track) =>
      track.id === 100 ? { ...track, mute: true } : track,
    );
    await nextTick();

    expect(sent).toEqual([]);
  });

  it('reflects transport state on the lamps', async () => {
    const isPlaying = ref(false);
    await mountSurface({}, { isPlaying });
    sent.length = 0;

    isPlaying.value = true;
    await nextTick();

    expect(sent).toEqual([[0x90, 94, 127]]);
  });

  it('subscribes to live meter levels and uses the louder stereo peak', async () => {
    const meter = mutableMeterSource();
    await mountSurface({}, { trackMeterSource: () => meter.source });
    sent.length = 0;

    meter.emit({ peakDbL: -24, peakDbR: -6 });
    flushFrame();

    // -6 dBFS maps to 0.9 of the shared -60..0 dB meter scale, i.e. MCU
    // segment 11. A one-shot closure read would not produce this delta.
    expect(sent).toContainEqual([0xd0, 11]);
  });

  it('maps a silent source to the bottom MCU meter segment', async () => {
    const meter = mutableMeterSource({
      peakDbL: SILENCE_DB,
      peakDbR: SILENCE_DB,
    });
    await mountSurface({}, { trackMeterSource: () => meter.source });

    expect(sent).toContainEqual([0xd0, 0]);
  });

  it('rebinds meter subscriptions when the bank moves', async () => {
    const meters = new Map<number, ReturnType<typeof mutableMeterSource>>();
    for (const track of trackList(10)) meters.set(track.id, mutableMeterSource());
    const store = useProjectStore();
    await mountSurface({}, { trackMeterSource: (trackId) => meters.get(trackId)?.source ?? null });
    sent.length = 0;

    store.controlSurface = { ...store.controlSurface, bankOffset: 2 };
    await nextTick();

    expect(meters.get(100)?.unsubscribeCount()).toBe(1);
    sent.length = 0;
    meters.get(100)?.emit({ peakDbL: 0, peakDbR: 0 });
    flushFrame();
    expect(sent).toEqual([]);

    meters.get(102)?.emit({ peakDbL: -6, peakDbR: -6 });
    flushFrame();
    expect(sent).toContainEqual([0xd0, 11]);
  });

  it('stops a disposed meter source from producing output', async () => {
    const meter = mutableMeterSource();
    await mountSurface({}, { trackMeterSource: () => meter.source });
    sent.length = 0;

    scope.stop();
    // Scope disposal emits one final hardware reset; later engine callbacks
    // must not resurrect feedback after the subscription was released.
    sent.length = 0;
    meter.emit({ peakDbL: 0, peakDbR: 0 });
    flushFrame();

    expect(meter.unsubscribeCount()).toBe(1);
    expect(sent).toEqual([]);
  });

  it('coalesces meter updates within one frame into a single feedback push', async () => {
    const meter = mutableMeterSource();
    await mountSurface({}, { trackMeterSource: () => meter.source });
    sent.length = 0;

    meter.emit({ peakDbL: -24, peakDbR: -24 });
    meter.emit({ peakDbL: -6, peakDbR: -6 });
    expect(sent).toEqual([]);
    flushFrame();

    // One push covers the eight bank strips; the superseded -24 dB level never goes out.
    const meterMessages = sent.filter((message) => message[0] === 0xd0);
    expect(meterMessages).toHaveLength(8);
    expect(meterMessages.every((message) => (message[1] & 0x0f) === 11)).toBe(true);
  });

  it('resets the hardware before a live surface scope is disposed', async () => {
    await mountSurface();
    sent.length = 0;

    scope.stop();

    expect(sent).toEqual(
      surfaceResetFeedback(8).flatMap((item) => encodeSurfaceFeedback('mcu', item)),
    );
  });
});

describe('control surface access', () => {
  it('asks for SysEx only when the protocol needs it', async () => {
    await mountSurface({ protocol: 'mcu' });
    expect(sysexRequested).toBe(false);

    scope.stop();
    setActivePinia(createPinia());
    installFakeMidi();
    await mountSurface({ protocol: 'hui' });
    expect(sysexRequested).toBe(true);
  });

  it('keeps the surface port out of the musical input path', async () => {
    const handle = await mountSurface();
    expect(handle.excludedInputIds.value).toEqual(['surface-in']);

    const store = useProjectStore();
    store.controlSurface = { ...store.controlSurface, protocol: 'none' };
    await nextTick();
    expect(handle.excludedInputIds.value).toEqual([]);
  });

  it('answers a HUI keep-alive ping', async () => {
    await mountSurface({ protocol: 'hui', feedback: false });
    sent.length = 0;

    fromSurface([0xf0, 0x00, 0x00, 0x66, 0x05, 0x00, 0x00, 0xf7]);

    expect(sent).toEqual([[0xf0, 0x00, 0x00, 0x66, 0x05, 0x00, 0x00, 0xf7]]);
  });
});

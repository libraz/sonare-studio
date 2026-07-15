import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createWebMidiOutput, routesFromTracks } from '@/engine/web-midi-output';
import type { EditorTrack } from '@/project/types';

const TRANSPORT_DESTINATION = 0xffffffff;

/** A fake Web MIDI output port recording everything written to it. */
function fakePort(id: string) {
  const sent: number[][] = [];
  const timestamps: Array<number | undefined> = [];
  return {
    id,
    name: `Port ${id}`,
    sent,
    timestamps,
    send(data: number[] | Uint8Array, timestamp?: number): void {
      sent.push([...data]);
      timestamps.push(timestamp);
    },
  };
}

/**
 * Installs a fake navigator.requestMIDIAccess exposing `ports` and returns a
 * cleanup function. Also returns an engine handle whose onMidiOut callback is
 * captured so the test can drive delivery.
 */
function setup(ports: ReturnType<typeof fakePort>[]) {
  const access = {
    outputs: new Map(ports.map((port) => [port.id, port])),
    onstatechange: null as (() => void) | null,
  };
  const requestMIDIAccess = vi.fn().mockResolvedValue(access);
  (navigator as any).requestMIDIAccess = requestMIDIAccess;

  let captured: ((events: { destinationId: number; bytes: number[] }[]) => void) | null = null;
  const handle = {
    ctx: {
      currentTime: 1,
      sampleRate: 48000,
      getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 5000 }),
    },
    engine: {
      onMidiOut: (cb: (events: { destinationId: number; bytes: number[] }[]) => void) => {
        captured = cb;
        return () => {
          captured = null;
        };
      },
    },
  } as unknown as EngineHandle;

  return {
    handle,
    emit: (events: { destinationId: number; bytes: number[] }[]) => captured?.(events),
    requestMIDIAccess,
  };
}

function setupLegacyStateChange(ports: ReturnType<typeof fakePort>[], previous = vi.fn()) {
  const base = setup(ports);
  const access = {
    outputs: new Map(ports.map((port) => [port.id, port])),
    onstatechange: previous as ((event: unknown) => void) | null,
  };
  base.requestMIDIAccess.mockResolvedValue(access);
  return { ...base, access, previous };
}

function setupEventTargetStateChange(ports: ReturnType<typeof fakePort>[]) {
  const base = setup(ports);
  let listener: ((event: unknown) => void) | null = null;
  const access = {
    outputs: new Map(ports.map((port) => [port.id, port])),
    onstatechange: null as ((event: unknown) => void) | null,
    addEventListener: vi.fn((_type: 'statechange', next: (event: unknown) => void) => {
      listener = next;
    }),
    removeEventListener: vi.fn((_type: 'statechange', next: (event: unknown) => void) => {
      if (listener === next) listener = null;
    }),
    emitStateChange: (event: unknown) => listener?.(event),
  };
  base.requestMIDIAccess.mockResolvedValue(access);
  return { ...base, access };
}

afterEach(() => {
  (navigator as any).requestMIDIAccess = undefined;
  vi.restoreAllMocks();
});

describe('routesFromTracks', () => {
  it('extracts a route per external-midi track and ignores other kinds', () => {
    const tracks = [
      { id: 1, kind: 'midi', instrument: { kind: 'synth-preset', preset: 'e-piano' } },
      {
        id: 2,
        kind: 'midi',
        instrument: { kind: 'external-midi', outputPortId: 'p1', channel: 3 },
      },
      {
        id: 5,
        kind: 'midi',
        instrument: { kind: 'external-midi', outputPortId: 'p2', channel: 0, sendClock: true },
      },
    ] as unknown as EditorTrack[];
    expect(routesFromTracks(tracks)).toEqual([
      { destinationId: 2, outputPortId: 'p1', channel: 3 },
      { destinationId: 5, outputPortId: 'p2', channel: 0, sendClock: true },
    ]);
  });

  it('extracts inherited project external-midi routes', () => {
    const tracks = [
      { id: 1, kind: 'midi', externalMidiMode: 'project' },
      {
        id: 2,
        kind: 'midi',
        instrument: { kind: 'external-midi', outputPortId: 'p2', channel: 8 },
      },
    ] as unknown as EditorTrack[];
    expect(
      routesFromTracks(tracks, { kind: 'external-midi', outputPortId: 'p1', channel: 2 }),
    ).toEqual([
      { destinationId: 1, outputPortId: 'p1', channel: 2 },
      { destinationId: 2, outputPortId: 'p2', channel: 8 },
    ]);
  });
});

describe('createWebMidiOutput', () => {
  it('delivers a track event to its routed port, overriding the channel', async () => {
    const port = fakePort('p1');
    const { handle, emit } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    expect(await bridge.start()).toBe(true);
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 5 }]);

    // Note-on on channel 0 from the engine is rewritten to the route's channel 5.
    emit([{ destinationId: 2, bytes: [0x90, 60, 100] }]);
    expect(port.sent).toEqual([[0x95, 60, 100]]);
    bridge.dispose();
  });

  it('converts dense render frames to Web MIDI timestamps without collapsing timing', async () => {
    const port = fakePort('p1');
    const { handle, emit } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 5 }]);

    emit([
      { destinationId: 2, renderFrame: 48000, bytes: [0x90, 60, 100] },
      { destinationId: 2, renderFrame: 48120, bytes: [0x80, 60, 0] },
    ] as never);

    expect(port.sent).toEqual([
      [0x95, 60, 100],
      [0x85, 60, 0],
    ]);
    expect(port.timestamps[0]).toBe(5000);
    expect(port.timestamps[1]).toBe(5002.5);
    bridge.dispose();
  });

  it('drops events for an unrouted destination', async () => {
    const port = fakePort('p1');
    const { handle, emit } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 0 }]);
    emit([{ destinationId: 99, bytes: [0x90, 60, 100] }]);
    expect(port.sent).toEqual([]);
    bridge.dispose();
  });

  it('sends all-notes-off to the old output/channel when a route is removed', async () => {
    const port = fakePort('p1');
    const { handle } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 5 }]);
    port.sent.length = 0;

    bridge.setRoutes([]);
    expect(port.sent).toEqual([[0xb5, 123, 0]]);
    bridge.dispose();
  });

  it('sends all-notes-off to the old output/channel when syncRoutes reroutes a track', async () => {
    const oldPort = fakePort('p1');
    const newPort = fakePort('p2');
    const { handle } = setup([oldPort, newPort]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.syncRoutes([
      {
        id: 2,
        kind: 'midi',
        instrument: { kind: 'external-midi', outputPortId: 'p1', channel: 5 },
      } as unknown as EditorTrack,
    ]);
    oldPort.sent.length = 0;

    bridge.syncRoutes([
      {
        id: 2,
        kind: 'midi',
        instrument: { kind: 'external-midi', outputPortId: 'p2', channel: 1 },
      } as unknown as EditorTrack,
    ]);
    expect(oldPort.sent).toEqual([[0xb5, 123, 0]]);
    expect(newPort.sent).toEqual([]);
    bridge.dispose();
  });

  it('dedupes all-notes-off per output/channel on route changes', async () => {
    const port = fakePort('p1');
    const { handle } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([
      { destinationId: 2, outputPortId: 'p1', channel: 5 },
      { destinationId: 3, outputPortId: 'p1', channel: 5 },
    ]);
    port.sent.length = 0;

    bridge.setRoutes([]);
    expect(port.sent).toEqual([[0xb5, 123, 0]]);
    bridge.dispose();
  });

  it('broadcasts transport/clock bytes only to clock-enabled ports', async () => {
    const clockPort = fakePort('p1');
    const plainPort = fakePort('p2');
    const { handle, emit } = setup([clockPort, plainPort]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([
      { destinationId: 2, outputPortId: 'p1', channel: 0, sendClock: true },
      { destinationId: 3, outputPortId: 'p2', channel: 0 },
    ]);
    emit([{ destinationId: TRANSPORT_DESTINATION, bytes: [0xf8] }]);
    expect(clockPort.sent).toEqual([[0xf8]]);
    expect(plainPort.sent).toEqual([]);
    bridge.dispose();
  });

  it('routes live channel voice with its input timestamp', async () => {
    const port = fakePort('p1');
    const { handle } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 7 }]);

    expect(bridge.sendLive(2, [0xe2, 0, 96], 6123)).toBe(true);
    expect(port.sent).toEqual([[0xe7, 0, 96]]);
    expect(port.timestamps).toEqual([6123]);
    expect(bridge.sendLive(99, [0xb0, 64, 127], 6124)).toBe(false);
    bridge.dispose();
  });

  it('stops delivering after dispose', async () => {
    const port = fakePort('p1');
    const { handle, emit } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 0 }]);
    bridge.dispose();
    expect(port.sent).toEqual([[0xb0, 123, 0]]);
    emit([{ destinationId: 2, bytes: [0x90, 60, 100] }]);
    expect(port.sent).toEqual([[0xb0, 123, 0]]);
  });

  it('reports unavailability when Web MIDI is missing', async () => {
    const { handle } = setup([]);
    (navigator as any).requestMIDIAccess = undefined;
    const bridge = createWebMidiOutput(handle);
    expect(await bridge.start()).toBe(false);
    expect(bridge.available()).toBe(false);
    bridge.dispose();
  });

  it('chains legacy statechange handlers and restores them on dispose', async () => {
    const first = fakePort('p1');
    const second = fakePort('p2');
    const { access, handle, previous } = setupLegacyStateChange([first]);
    const bridge = createWebMidiOutput(handle);

    expect(await bridge.start()).toBe(true);
    expect(bridge.outputs()).toEqual([{ id: 'p1', name: 'Port p1' }]);

    access.outputs.set('p2', second);
    access.onstatechange?.({ type: 'statechange' });

    expect(previous).toHaveBeenCalledWith({ type: 'statechange' });
    expect(bridge.outputs()).toEqual([
      { id: 'p1', name: 'Port p1' },
      { id: 'p2', name: 'Port p2' },
    ]);

    bridge.dispose();
    expect(access.onstatechange).toBe(previous);
  });

  it('removes EventTarget statechange listeners on dispose', async () => {
    const first = fakePort('p1');
    const second = fakePort('p2');
    const { access, handle } = setupEventTargetStateChange([first]);
    const bridge = createWebMidiOutput(handle);

    expect(await bridge.start()).toBe(true);
    expect(access.addEventListener).toHaveBeenCalledTimes(1);
    expect(access.addEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));
    expect(bridge.outputs()).toEqual([{ id: 'p1', name: 'Port p1' }]);

    access.outputs.set('p2', second);
    access.emitStateChange({ type: 'statechange' });
    expect(bridge.outputs()).toEqual([
      { id: 'p1', name: 'Port p1' },
      { id: 'p2', name: 'Port p2' },
    ]);

    bridge.dispose();
    expect(access.removeEventListener).toHaveBeenCalledTimes(1);
    expect(access.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));

    access.outputs.set('p3', fakePort('p3'));
    access.emitStateChange({ type: 'statechange' });
    expect(bridge.outputs()).toEqual([]);
  });
});

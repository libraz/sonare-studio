import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createWebMidiOutput, routesFromTracks } from '@/engine/web-midi-output';
import type { EditorTrack } from '@/project/types';

const TRANSPORT_DESTINATION = 0xffffffff;

/** A fake Web MIDI output port recording everything written to it. */
function fakePort(id: string) {
  const sent: number[][] = [];
  return {
    id,
    name: `Port ${id}`,
    sent,
    send(data: number[] | Uint8Array): void {
      sent.push([...data]);
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

  it('stops delivering after dispose', async () => {
    const port = fakePort('p1');
    const { handle, emit } = setup([port]);
    const bridge = createWebMidiOutput(handle);
    await bridge.start();
    bridge.setRoutes([{ destinationId: 2, outputPortId: 'p1', channel: 0 }]);
    bridge.dispose();
    emit([{ destinationId: 2, bytes: [0x90, 60, 100] }]);
    expect(port.sent).toEqual([]);
  });

  it('reports unavailability when Web MIDI is missing', async () => {
    const { handle } = setup([]);
    (navigator as any).requestMIDIAccess = undefined;
    const bridge = createWebMidiOutput(handle);
    expect(await bridge.start()).toBe(false);
    expect(bridge.available()).toBe(false);
    bridge.dispose();
  });
});

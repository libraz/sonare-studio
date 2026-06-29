/**
 * Web MIDI output bridge: delivers the engine's external-MIDI stream to live
 * Web MIDI output ports.
 *
 * The engine routes a track marked external (see midi-sync) to its output
 * queue instead of an internal synth; the worklet drains that queue and posts
 * batches to the main thread, already lowered to MIDI 1.0 bytes. This bridge
 * subscribes to those batches and writes each event to the port chosen for its
 * track, overriding the channel to the instrument's configured channel.
 *
 * Transport / clock bytes (tagged with the transport destination) are broadcast
 * to every port whose track opted into clock sync.
 *
 * Timing: events carry an in-block renderFrame, but this bridge sends them
 * immediately (no MIDIOutput timestamp). Sample-accurate scheduling against the
 * AudioContext clock is a future refinement; for now delivery rides the
 * per-block postMessage cadence.
 */

import type { TrackInstrument } from '@/project/instrument';
import type { EditorTrack } from '@/project/types';
import type { EngineHandle } from './engine';

/** Destination sentinel the engine tags transport/clock bytes with. */
const TRANSPORT_DESTINATION = 0xffffffff;

/** A single track's external-MIDI routing: where its MIDI goes and on which channel. */
export interface ExternalMidiRoute {
  /** Engine destination id (the track id). */
  destinationId: number;
  /** Web MIDI output port id. */
  outputPortId: string;
  /** MIDI channel to transmit on (0-15). */
  channel: number;
  /** When true, this port also receives MIDI clock + transport bytes. */
  sendClock?: boolean;
}

/** Public id + display name of a Web MIDI output port. */
export interface WebMidiOutputInfo {
  id: string;
  name: string;
}

/** Bridge controlling external-MIDI delivery for one engine handle. */
export interface WebMidiOutputBridge {
  /** Web MIDI availability: null until start() resolves it, then boolean. */
  available(): boolean | null;
  /** Currently known output ports (refreshed on hot-plug). */
  outputs(): WebMidiOutputInfo[];
  /** Replaces the destination → port/channel routing table. */
  setRoutes(routes: readonly ExternalMidiRoute[]): void;
  /** Derives and applies routes from the project's external-MIDI tracks. */
  syncRoutes(tracks: ReadonlyArray<EditorTrack>): void;
  /**
   * Requests MIDI access and begins delivering engine MIDI to ports. Degrades
   * gracefully: resolves false (with available updated) when Web MIDI is
   * unavailable or permission is denied. Idempotent.
   */
  start(): Promise<boolean>;
  /** Detaches the engine subscription and releases access. Idempotent. */
  dispose(): void;
}

// Minimal Web MIDI typings — the standard DOM lib does not declare these and we
// avoid a hard dependency on @types/webmidi (mirrors useWebMidi's structural
// approach for inputs).
interface MidiOutputLike {
  id: string;
  name?: string | null;
  send(data: number[] | Uint8Array, timestamp?: number): void;
}
interface MidiAccessLike {
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((event: unknown) => void) | null;
  addEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
}
interface NavigatorWithMidi {
  requestMIDIAccess?(options?: { sysex?: boolean }): Promise<MidiAccessLike>;
}

/** Builds external-MIDI routes from a project's tracks (exported for tests). */
export function routesFromTracks(tracks: ReadonlyArray<EditorTrack>): ExternalMidiRoute[] {
  const routes: ExternalMidiRoute[] = [];
  for (const track of tracks) {
    const instrument: TrackInstrument | undefined = track.instrument;
    if (instrument?.kind !== 'external-midi') continue;
    routes.push({
      destinationId: track.id,
      outputPortId: instrument.outputPortId,
      channel: instrument.channel,
      ...(instrument.sendClock ? { sendClock: true } : {}),
    });
  }
  return routes;
}

/**
 * Returns `bytes` with the channel nibble of a channel-voice status byte
 * (0x80-0xEF) replaced by `channel`. System messages (0xF0+) are returned
 * unchanged, since they carry no channel.
 */
function withChannel(bytes: number[], channel: number): number[] {
  const status = bytes[0];
  if (status >= 0x80 && status <= 0xef) {
    return [(status & 0xf0) | (channel & 0x0f), ...bytes.slice(1)];
  }
  return bytes;
}

/**
 * Creates a Web MIDI output bridge bound to one engine handle. Create a fresh
 * instance per engine start; dispose detaches the engine subscription.
 *
 * @param handle Running engine handle from createEngine.
 * @returns The bridge facade.
 */
export function createWebMidiOutput(handle: EngineHandle): WebMidiOutputBridge {
  let access: MidiAccessLike | null = null;
  let available: boolean | null = null;
  let disposed = false;
  let routes: ExternalMidiRoute[] = [];
  let outputsList: WebMidiOutputInfo[] = [];
  const routeByDestination = new Map<number, ExternalMidiRoute>();
  let clockPortIds: string[] = [];

  const rebuildRouteIndex = (): void => {
    routeByDestination.clear();
    const clock = new Set<string>();
    for (const route of routes) {
      routeByDestination.set(route.destinationId, route);
      if (route.sendClock) clock.add(route.outputPortId);
    }
    clockPortIds = [...clock];
  };

  const refreshOutputs = (): void => {
    outputsList = access
      ? [...access.outputs.values()].map((port) => ({ id: port.id, name: port.name ?? port.id }))
      : [];
  };

  const deliver = (events: ReadonlyArray<{ destinationId: number; bytes: number[] }>): void => {
    if (disposed || !access) return;
    for (const event of events) {
      if (event.bytes.length === 0) continue;
      if (event.destinationId === TRANSPORT_DESTINATION) {
        for (const portId of clockPortIds) access.outputs.get(portId)?.send(event.bytes);
        continue;
      }
      const route = routeByDestination.get(event.destinationId);
      if (!route) continue;
      access.outputs.get(route.outputPortId)?.send(withChannel(event.bytes, route.channel));
    }
  };

  const unsubscribe = handle.engine.onMidiOut(deliver);

  return {
    available: () => available,
    outputs: () => outputsList,
    setRoutes(next: readonly ExternalMidiRoute[]): void {
      routes = [...next];
      rebuildRouteIndex();
    },
    syncRoutes(tracks: ReadonlyArray<EditorTrack>): void {
      routes = routesFromTracks(tracks);
      rebuildRouteIndex();
    },
    async start(): Promise<boolean> {
      if (access) return true;
      const nav = navigator as unknown as NavigatorWithMidi;
      if (typeof nav.requestMIDIAccess !== 'function') {
        available = false;
        return false;
      }
      try {
        access = await nav.requestMIDIAccess({ sysex: false });
        available = true;
        refreshOutputs();
        const onChange = (): void => refreshOutputs();
        if (access.addEventListener) access.addEventListener('statechange', onChange);
        else access.onstatechange = onChange;
        return true;
      } catch {
        available = false;
        return false;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      access = null;
      routes = [];
      routeByDestination.clear();
      clockPortIds = [];
      outputsList = [];
    },
  };
}

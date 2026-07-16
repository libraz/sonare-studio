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
 * Engine render frames are translated through the AudioContext output clock
 * and passed to MIDIOutput.send, preserving ordering even when the main thread
 * receives a dense batch late.
 */

import { type ExternalMidiInstrument, effectiveTrackInstrument } from '@/project/instrument';
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
  syncRoutes(
    tracks: ReadonlyArray<EditorTrack>,
    projectExternalMidi?: ExternalMidiInstrument | null,
  ): void;
  /** Sends one immediate live channel-voice message through a destination route. */
  sendLive(destinationId: number, bytes: ReadonlyArray<number>, timestampMs?: number): boolean;
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
  removeEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
}
interface NavigatorWithMidi {
  requestMIDIAccess?(options?: { sysex?: boolean }): Promise<MidiAccessLike>;
}

/** MIDI CC used by the standard All Notes Off panic message. */
const MIDI_CC_ALL_NOTES_OFF = 123;

/** Builds external-MIDI routes from a project's tracks (exported for tests). */
export function routesFromTracks(
  tracks: ReadonlyArray<EditorTrack>,
  projectExternalMidi?: ExternalMidiInstrument | null,
): ExternalMidiRoute[] {
  const routes: ExternalMidiRoute[] = [];
  for (const track of tracks) {
    if (track.kind !== 'midi') continue;
    const instrument = effectiveTrackInstrument(track, projectExternalMidi);
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

/** Stable route identity for one physical output/channel pair. */
function outputChannelKey(route: ExternalMidiRoute): string {
  return `${route.outputPortId}:${route.channel & 0x0f}`;
}

/** Maps an absolute engine render frame onto the Web MIDI performance clock. */
export function renderFramePerformanceTimestamp(
  context: Pick<BaseAudioContext, 'currentTime' | 'sampleRate'> & {
    getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
  },
  renderFrame: number,
  performanceNow = () => performance.now(),
): number | undefined {
  if (!Number.isFinite(renderFrame) || renderFrame < 0 || !(context.sampleRate > 0))
    return undefined;
  const output = context.getOutputTimestamp?.();
  const anchorContextTime = output?.contextTime ?? context.currentTime;
  const anchorPerformanceTime = output?.performanceTime ?? performanceNow();
  if (!Number.isFinite(anchorContextTime) || !Number.isFinite(anchorPerformanceTime)) {
    return undefined;
  }
  return anchorPerformanceTime + (renderFrame / context.sampleRate - anchorContextTime) * 1000;
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
  let onStateChange: ((event: unknown) => void) | null = null;
  let previousOnStateChange: ((event: unknown) => void) | null = null;
  let startGeneration = 0;
  let startPromise: Promise<boolean> | null = null;
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

  const sendToPort = (
    port: MidiOutputLike | undefined,
    bytes: number[] | Uint8Array,
    timestampMs?: number,
  ): boolean => {
    if (!port) return false;
    try {
      if (timestampMs === undefined) port.send(bytes);
      else port.send(bytes, timestampMs);
      return true;
    } catch {
      return false;
    }
  };

  const sendAllNotesOff = (route: ExternalMidiRoute): void => {
    sendToPort(access?.outputs.get(route.outputPortId), [
      0xb0 | (route.channel & 0x0f),
      MIDI_CC_ALL_NOTES_OFF,
      0,
    ]);
  };

  const panicChangedRoutes = (next: readonly ExternalMidiRoute[]): void => {
    if (!access || routes.length === 0) return;
    const nextByDestination = new Map(next.map((route) => [route.destinationId, route]));
    const panickedOutputs = new Set<string>();
    for (const route of routes) {
      const nextRoute = nextByDestination.get(route.destinationId);
      if (
        nextRoute &&
        nextRoute.outputPortId === route.outputPortId &&
        (nextRoute.channel & 0x0f) === (route.channel & 0x0f)
      ) {
        continue;
      }
      const key = outputChannelKey(route);
      if (panickedOutputs.has(key)) continue;
      sendAllNotesOff(route);
      panickedOutputs.add(key);
    }
  };

  const sendRouted = (
    destinationId: number,
    bytes: ReadonlyArray<number>,
    timestampMs?: number,
  ): boolean => {
    const route = routeByDestination.get(destinationId);
    if (!route || bytes.length === 0) return false;
    const port = access?.outputs.get(route.outputPortId);
    if (!port) return false;
    const routed = withChannel([...bytes], route.channel);
    return sendToPort(port, routed, timestampMs);
  };

  const deliver = (
    events: ReadonlyArray<{ destinationId: number; renderFrame: number; bytes: number[] }>,
  ): void => {
    if (disposed || !access) return;
    for (const event of events) {
      if (event.bytes.length === 0) continue;
      const timestampMs = renderFramePerformanceTimestamp(handle.ctx, event.renderFrame);
      if (event.destinationId === TRANSPORT_DESTINATION) {
        for (const portId of clockPortIds) {
          const port = access.outputs.get(portId);
          sendToPort(port, event.bytes, timestampMs);
        }
        continue;
      }
      sendRouted(event.destinationId, event.bytes, timestampMs);
    }
  };

  const unsubscribe = handle.engine.onMidiOut(deliver);

  return {
    available: () => available,
    outputs: () => outputsList,
    setRoutes(next: readonly ExternalMidiRoute[]): void {
      panicChangedRoutes(next);
      routes = [...next];
      rebuildRouteIndex();
    },
    syncRoutes(
      tracks: ReadonlyArray<EditorTrack>,
      projectExternalMidi?: ExternalMidiInstrument | null,
    ): void {
      const next = routesFromTracks(tracks, projectExternalMidi);
      panicChangedRoutes(next);
      routes = next;
      rebuildRouteIndex();
    },
    sendLive(destinationId: number, bytes: ReadonlyArray<number>, timestampMs?: number): boolean {
      if (disposed || !access) return false;
      return sendRouted(destinationId, bytes, timestampMs);
    },
    async start(): Promise<boolean> {
      if (disposed) return false;
      if (access) return true;
      if (startPromise) return startPromise;
      const nav = navigator as unknown as NavigatorWithMidi;
      if (typeof nav.requestMIDIAccess !== 'function') {
        available = false;
        return false;
      }
      const generation = ++startGeneration;
      const operation = (async (): Promise<boolean> => {
        try {
          const granted = await nav.requestMIDIAccess?.({ sysex: false });
          if (!granted || disposed || generation !== startGeneration) return false;
          access = granted;
          available = true;
          refreshOutputs();
          onStateChange = () => {
            if (disposed || access !== granted || generation !== startGeneration) return;
            refreshOutputs();
          };
          if (granted.addEventListener) granted.addEventListener('statechange', onStateChange);
          else {
            previousOnStateChange = granted.onstatechange;
            granted.onstatechange = (event: unknown) => {
              previousOnStateChange?.(event);
              onStateChange?.(event);
            };
          }
          return true;
        } catch {
          if (!disposed && generation === startGeneration) available = false;
          return false;
        }
      })();
      startPromise = operation;
      return operation.finally(() => {
        if (startPromise === operation) startPromise = null;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      startGeneration += 1;
      try {
        panicChangedRoutes([]);
      } catch {
        // Continue releasing the subscription and statechange listener.
      }
      try {
        unsubscribe();
      } catch {
        // A broken engine subscription must not retain Web MIDI listeners.
      }
      const previousAccess = access;
      const previousListener = onStateChange;
      try {
        if (previousAccess && previousListener) {
          if (previousAccess.removeEventListener) {
            previousAccess.removeEventListener('statechange', previousListener);
          } else {
            previousAccess.onstatechange = previousOnStateChange;
          }
        }
      } catch {
        // Local state is still cleared below.
      } finally {
        access = null;
        onStateChange = null;
        previousOnStateChange = null;
      }
      routes = [];
      routeByDestination.clear();
      clockPortIds = [];
      outputsList = [];
    },
  };
}

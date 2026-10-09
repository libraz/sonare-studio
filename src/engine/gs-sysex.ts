import type { SmfSysExPacket } from '@/project/types';

/** Maximum SysEx frame accepted by libsonare's realtime engine. */
export const MAX_REALTIME_SYSEX_BYTES = 512;

/** Minimal clip shape needed to inspect the opaque SMF SysEx sidecar. */
export interface GsSysExClipSource {
  startPpq: number;
  smfSysEx?: ReadonlyArray<SmfSysExPacket>;
}

/** A destination that was successfully bound to an internal SF2 player. */
export interface GsSysExDestination {
  destinationId: number;
  /** Changes whenever the engine binding is replaced, so setup is replayed. */
  bindingKey: string;
}

/** Collected setup frames and packets that cannot be applied at engine setup. */
export interface GsSetupSysexCollection {
  /** Complete F0...F7 frames at timeline PPQ 0, with duplicate bytes removed. */
  frames: ReadonlyArray<Uint8Array>;
  /** Sidecar packets retained for SMF roundtrip but not sent to the engine. */
  unsupportedPacketCount: number;
}

/** Result of an optional push to one or more bound SF2 destinations. */
export interface GsSetupSysexPushResult extends GsSetupSysexCollection {
  /** Stable state key for avoiding duplicate queueing during ordinary sync. */
  key: string;
  /** Whether the destination/frame state changed since the supplied key. */
  changed: boolean;
  /** Number of queued destination/frame commands. */
  sentCount: number;
}

/**
 * Collects only the setup SysEx frames that the realtime engine can apply
 * safely. The project sidecar keeps SMF framing opaque, while the engine API
 * needs one complete frame including F0 and F7. Mid-song packets, F7
 * continuations, unterminated fragments and frames over the engine limit stay
 * in the project for SMF re-export and are counted here.
 */
export function collectGsSetupSysex(
  clips: ReadonlyArray<GsSysExClipSource>,
): GsSetupSysexCollection {
  const frames: Uint8Array[] = [];
  const seen = new Set<string>();
  let unsupportedPacketCount = 0;

  for (const clip of clips) {
    for (const packet of clip.smfSysEx ?? []) {
      const timelinePpq = clip.startPpq + packet.ppq;
      const data = packet.data;
      const isValidData = data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff);
      const isCompleteSetupFrame =
        Number.isFinite(timelinePpq) &&
        timelinePpq === 0 &&
        packet.status === 0xf0 &&
        data.length > 0 &&
        data[data.length - 1] === 0xf7 &&
        data.length + 1 <= MAX_REALTIME_SYSEX_BYTES &&
        isValidData;
      if (!isCompleteSetupFrame) {
        unsupportedPacketCount += 1;
        continue;
      }

      const frame = Uint8Array.from([0xf0, ...data]);
      const key = bytesKey(frame);
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push(frame);
    }
  }

  return { frames, unsupportedPacketCount };
}

/**
 * Pushes setup frames to each unique SF2 destination. The caller supplies only
 * destinations whose SF2 binding succeeded; NativeSynth, external and
 * fallback destinations are therefore excluded by construction.
 *
 * The render frame is deliberately omitted (apply immediately). libsonare
 * realises a GS EFX SysEx on the control thread and applies the resulting
 * chain at the next audio block, so scheduling a future packet would make its
 * effect active before that packet's musical position.
 */
export function pushGsSetupSysex(
  engine: {
    pushMidiSysex?: (destinationId: number, data: Uint8Array, renderFrame?: number) => void;
  },
  clips: ReadonlyArray<GsSysExClipSource>,
  destinations: ReadonlyArray<GsSysExDestination>,
  previousKey?: string,
): GsSetupSysexPushResult {
  const collection = collectGsSetupSysex(clips);
  const uniqueDestinations = new Map<number, string>();
  for (const destination of destinations) {
    if (!Number.isInteger(destination.destinationId) || destination.destinationId < 0) continue;
    if (!uniqueDestinations.has(destination.destinationId)) {
      uniqueDestinations.set(destination.destinationId, destination.bindingKey);
    }
  }
  const destinationState = [...uniqueDestinations.entries()].sort(([a], [b]) => a - b);
  const key = JSON.stringify({
    frames: collection.frames.map(bytesKey),
    destinations: destinationState,
  });
  const changed = key !== previousKey;
  if (!changed || collection.frames.length === 0 || destinationState.length === 0) {
    return { ...collection, key, changed, sentCount: 0 };
  }

  if (typeof engine.pushMidiSysex !== 'function') {
    return { ...collection, key, changed, sentCount: 0 };
  }
  let sentCount = 0;
  for (const [destinationId] of destinationState) {
    for (const frame of collection.frames) {
      engine.pushMidiSysex(destinationId, frame);
      sentCount += 1;
    }
  }
  return { ...collection, key, changed, sentCount };
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

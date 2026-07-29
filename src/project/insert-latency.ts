import type { InsertSlot, MixerStrip } from './mixer';

/** Minimal catalog shape needed to derive processor latency. */
export interface InsertLatencyCatalogEntry {
  id: string;
  /** Reported processing latency in samples at the engine/render sample rate. */
  latencySamples?: number;
}

export interface InsertLatencyResolverOptions {
  /** Sample rate used to convert explicit lookaheadMs params into samples. */
  sampleRate?: number;
}

/** Resolves one insert slot's latency in samples. */
export type InsertLatencyResolver = (slot: Pick<InsertSlot, 'processor' | 'params'>) => number;

/** A return bus whose strip contributes latency to every routed signal. */
export interface InsertPdcBus {
  id: string;
  strip?: Pick<MixerStrip, 'inserts'>;
}

/** A precomputed PDC plan shared by the live and offline engine paths. */
export interface InsertPdcPlan {
  /** Largest signal-path latency before master processing. */
  maxLatencySamples: number;
  /** Returns one lane's manual delay plus its required automatic compensation. */
  delayFor(track: InsertPdcTrack): number;
}

/** Minimal track routing shape needed to calculate pre-master insert latency. */
export interface InsertPdcTrack {
  id?: number;
  kind?: string;
  frozen?: unknown;
  groupId?: number;
  mixer?: Pick<MixerStrip, 'inserts' | 'channelDelaySamples' | 'outputBusId'>;
}

/** Returns a non-negative whole-sample latency, tolerating missing/invalid metadata. */
function sanitizeLatencySamples(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function paramsLatencyHintSamples(
  params: Record<string, number | boolean>,
  sampleRate: number | undefined,
): number {
  const explicit = Math.max(
    sanitizeLatencySamples(params.latencySamples),
    sanitizeLatencySamples(params.latency),
    sanitizeLatencySamples(params.delaySamples),
    sanitizeLatencySamples(params.lookaheadSamples),
  );
  if (explicit > 0) return explicit;
  const lookaheadMs = typeof params.lookaheadMs === 'number' ? params.lookaheadMs : 0;
  return Number.isFinite(lookaheadMs) && lookaheadMs > 0 && sampleRate !== undefined
    ? sanitizeLatencySamples((lookaheadMs * sampleRate) / 1000)
    : 0;
}

/** Builds a resolver from a structured processor catalog. Missing ids are zero-latency. */
export function insertLatencyResolverFromCatalog(
  entries: ReadonlyArray<InsertLatencyCatalogEntry> | null | undefined,
  options: InsertLatencyResolverOptions = {},
): InsertLatencyResolver {
  const byProcessor = new Map<string, number>();
  for (const entry of entries ?? []) {
    byProcessor.set(entry.id, sanitizeLatencySamples(entry.latencySamples));
  }
  return (slot) => {
    const catalogLatency = byProcessor.get(slot.processor) ?? 0;
    return catalogLatency > 0
      ? catalogLatency
      : paramsLatencyHintSamples(slot.params, options.sampleRate);
  };
}

/** Sums enabled insert latency for one chain. Disabled/bypassed slots contribute zero. */
export function insertChainLatencySamples(
  inserts: ReadonlyArray<InsertSlot>,
  resolveLatency: InsertLatencyResolver,
): number {
  let total = 0;
  for (const slot of inserts) {
    if (!slot.enabled) continue;
    total += sanitizeLatencySamples(resolveLatency(slot));
  }
  return total;
}

/** Sums enabled insert latency for a strip. */
export function stripInsertLatencySamples(
  strip: Pick<MixerStrip, 'inserts'> | undefined,
  resolveLatency: InsertLatencyResolver,
): number {
  return insertChainLatencySamples(strip?.inserts ?? [], resolveLatency);
}

/**
 * Builds a PDC plan from primary output routes. A content lane reaches either
 * its parent group bus, its selected return bus, or the master directly; the
 * destination bus's inserts are therefore part of that lane's audible path.
 * Return-bus latency is also included in the project maximum so send returns
 * cannot be ignored when they are the longest live signal path.
 */
export function createInsertPdcPlan(
  tracks: ReadonlyArray<InsertPdcTrack>,
  buses: ReadonlyArray<InsertPdcBus>,
  resolveLatency: InsertLatencyResolver,
): InsertPdcPlan {
  const tracksById = new Map(
    tracks.flatMap((track) => (typeof track.id === 'number' ? [[track.id, track] as const] : [])),
  );
  const busLatencyById = new Map(
    buses.map((bus) => [bus.id, stripInsertLatencySamples(bus.strip, resolveLatency)]),
  );

  /** Latency of the bus path downstream from a track's own lane strip. */
  function routeLatency(track: InsertPdcTrack, seenGroups = new Set<number>()): number {
    if (track.groupId !== undefined) {
      if (seenGroups.has(track.groupId)) return 0;
      const group = tracksById.get(track.groupId);
      if (group?.kind !== 'group') return 0;
      const nextSeen = new Set(seenGroups).add(track.groupId);
      return stripInsertLatencySamples(group.mixer, resolveLatency) + routeLatency(group, nextSeen);
    }
    const outputBusId = track.mixer?.outputBusId;
    return outputBusId === undefined ? 0 : (busLatencyById.get(outputBusId) ?? 0);
  }

  /** Content lane latency; group tracks themselves are silent routing busses. */
  function signalLatency(track: InsertPdcTrack): number {
    const ownLatency =
      track.kind === 'group' || track.frozen !== undefined
        ? 0
        : stripInsertLatencySamples(track.mixer, resolveLatency);
    return ownLatency + routeLatency(track);
  }

  let maxLatencySamples = 0;
  for (const busLatency of busLatencyById.values()) {
    maxLatencySamples = Math.max(maxLatencySamples, busLatency);
  }
  for (const track of tracks) {
    if (track.kind !== 'group') {
      maxLatencySamples = Math.max(maxLatencySamples, signalLatency(track));
    }
  }

  return {
    maxLatencySamples,
    delayFor(track): number {
      const manualDelay = Math.max(0, Math.round(track.mixer?.channelDelaySamples ?? 0));
      return manualDelay + Math.max(0, maxLatencySamples - signalLatency(track));
    },
  };
}

/**
 * Computes the automatic plugin-delay compensation for one track lane.
 *
 * The engine-side channel delay is the only host-controlled per-track delay
 * stage. Keep the user's manual channel alignment delay and add the difference
 * between the project-wide maximum insert latency and this track's insert
 * latency. Frozen tracks bypass their own strip DSP, so their insert latency is
 * zero but they still receive compensation for other tracks' latency.
 */
export function trackPdcDelaySamples(
  track: {
    kind?: string;
    frozen?: unknown;
    mixer?: Pick<MixerStrip, 'inserts' | 'channelDelaySamples'>;
  },
  maxInsertLatencySamples: number,
  resolveLatency: InsertLatencyResolver,
): number {
  const manualDelay = Math.max(0, Math.round(track.mixer?.channelDelaySamples ?? 0));
  const ownLatency =
    track.kind === 'group' || track.frozen !== undefined
      ? 0
      : stripInsertLatencySamples(track.mixer, resolveLatency);
  return manualDelay + Math.max(0, Math.round(maxInsertLatencySamples) - ownLatency);
}

/** Returns the largest active, non-frozen, non-group track insert latency. */
export function maxTrackInsertLatencySamples(
  tracks: ReadonlyArray<{
    kind?: string;
    frozen?: unknown;
    mixer?: Pick<MixerStrip, 'inserts'>;
  }>,
  resolveLatency: InsertLatencyResolver,
): number {
  let max = 0;
  for (const track of tracks) {
    if (track.kind === 'group' || track.frozen !== undefined) continue;
    max = Math.max(max, stripInsertLatencySamples(track.mixer, resolveLatency));
  }
  return max;
}

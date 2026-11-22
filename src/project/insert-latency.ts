import type {
  MasteringInsertName,
  MasteringInsertParamInfo,
  MasteringInsertTiming,
  MasteringInsertTimingRequest,
} from '@/wasm/index.js';
import {
  audibleOutputBusId,
  busOutputChain,
  type InsertParamValue,
  type InsertSlot,
  isInsertParamValue,
  type MixerStrip,
} from './mixer';

/** Minimal catalog shape needed to derive processor latency. */
export interface InsertLatencyCatalogEntry {
  id: string;
  /** Latency the processor reports at its default parameters and 48 kHz. */
  latencySamples?: number;
  /** Parameter keys; one without an id is read only while the insert is built. */
  params?: ReadonlyArray<Pick<MasteringInsertParamInfo, 'name' | 'id'>>;
}

/** Engine query for the latency a configured insert reports (masteringInsertTiming). */
export type InsertTimingQuery = (
  request: MasteringInsertTimingRequest,
) => Pick<MasteringInsertTiming, 'latencySamples'>;

/** Resolves one insert slot's latency in samples. */
export type InsertLatencyResolver = (slot: Pick<InsertSlot, 'processor' | 'params'>) => number;

/** A return bus whose strip contributes latency to every routed signal. */
export interface InsertPdcBus {
  id: string;
  strip?: Pick<MixerStrip, 'inserts' | 'outputBusId'>;
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

/** Answered timing queries per query function; one configuration always reports the same latency. */
const timingCache = new WeakMap<InsertTimingQuery, Map<string, number>>();

/**
 * Builds a resolver that asks the engine what latency each configured insert
 * reports. Only the keys read while the insert is built reach the query, since
 * the rest are patched live and cannot move its latency; so a knob drag reuses
 * a cached answer. Without a query, or when the engine refuses the
 * configuration, the catalog's default latency stands in. Unknown processors
 * are zero-latency.
 */
export function insertLatencyResolverFromCatalog(
  entries: ReadonlyArray<InsertLatencyCatalogEntry> | null | undefined,
  sampleRate: number,
  timing?: InsertTimingQuery,
): InsertLatencyResolver {
  const byProcessor = new Map((entries ?? []).map((entry) => [entry.id, entry]));
  let answers = timing ? timingCache.get(timing) : undefined;
  if (timing && !answers) {
    answers = new Map();
    timingCache.set(timing, answers);
  }
  return (slot) => {
    const entry = byProcessor.get(slot.processor);
    if (!entry) return 0;
    const fallback = sanitizeLatencySamples(entry.latencySamples);
    if (!timing || !answers) return fallback;
    const buildKeys = new Set(
      (entry.params ?? []).filter((param) => param.id === undefined).map((param) => param.name),
    );
    const buildParams: Record<string, InsertParamValue> = {};
    for (const [key, value] of Object.entries(slot.params).sort(([a], [b]) => a.localeCompare(b))) {
      if (buildKeys.has(key) && isInsertParamValue(value)) {
        buildParams[key] = value;
      }
    }
    const cacheKey = `${slot.processor}|${sampleRate}|${JSON.stringify(buildParams)}`;
    let latency = answers.get(cacheKey);
    if (latency === undefined) {
      try {
        latency = sanitizeLatencySamples(
          timing({
            insert: slot.processor as MasteringInsertName,
            params: buildParams as MasteringInsertTimingRequest['params'],
            sampleRate,
          }).latencySamples,
        );
      } catch {
        latency = fallback;
      }
      answers.set(cacheKey, latency);
    }
    return latency;
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
 * its parent group bus, its selected return bus, or the master directly, and a
 * bus may route on into another bus; every bus on that path is part of the
 * lane's audible latency. The project maximum is taken over content lanes
 * only, so an un-routed return or an inaudible stored route delays nothing.
 */
export function createInsertPdcPlan(
  tracks: ReadonlyArray<InsertPdcTrack>,
  buses: ReadonlyArray<InsertPdcBus>,
  resolveLatency: InsertLatencyResolver,
): InsertPdcPlan {
  const tracksById = new Map(
    tracks.flatMap((track) => (typeof track.id === 'number' ? [[track.id, track] as const] : [])),
  );
  const busesById = new Map(buses.map((bus) => [bus.id, bus]));

  /** Latency from a bus input to master, following each bus's own output route. */
  function busPathLatency(busId: string | undefined): number {
    return busOutputChain(busId, busesById).reduce(
      (sum, bus) => sum + stripInsertLatencySamples(bus.strip, resolveLatency),
      0,
    );
  }

  /** Latency of the bus path downstream from a track's own lane strip. */
  function routeLatency(track: InsertPdcTrack, seenGroups = new Set<number>()): number {
    if (track.groupId !== undefined) {
      if (seenGroups.has(track.groupId)) return 0;
      const group = tracksById.get(track.groupId);
      if (group?.kind !== 'group') return 0;
      const nextSeen = new Set(seenGroups).add(track.groupId);
      return stripInsertLatencySamples(group.mixer, resolveLatency) + routeLatency(group, nextSeen);
    }
    return busPathLatency(audibleOutputBusId(track));
  }

  /** Content lane latency; group tracks themselves are silent routing busses. */
  function signalLatency(track: InsertPdcTrack): number {
    // A frozen asset already contains its own strip's processing latency.
    // Count that baked delay as part of the signal path so PDC adds only the
    // remaining difference, rather than delaying the frozen lane a second time.
    const ownLatency =
      track.kind === 'group' ? 0 : stripInsertLatencySamples(track.mixer, resolveLatency);
    return ownLatency + routeLatency(track);
  }

  let maxLatencySamples = 0;
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

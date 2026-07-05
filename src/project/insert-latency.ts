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

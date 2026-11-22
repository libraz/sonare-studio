/** Audio-export preflight for omissions that would otherwise become silence. */

import type { MasteringInsertName } from '@libraz/libsonare';
import { errorMessage } from '@/lib/errors';
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  validateAssetPayload,
} from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import { loadFont } from '@/project/fonts';
import { effectiveTrackInstrument } from '@/project/instrument';
import {
  audibleOutputBusId,
  busOutputChain,
  type InsertParamValue,
  type InsertSlot,
  isInsertParamValue,
  tracksWithVcaSolo,
} from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';
import {
  ppqSpanIntersectsRange,
  programOutputDocument,
  type RenderPpqRange,
} from './engine-render-context';
import { MAX_RELEASE_TAIL_SECONDS } from './engine-render-types';
import type { MixdownRangePpq } from './mixdown';
import { documentTempoSegments, planExportRender } from './render-plan';

/** Structured reference to what pulled an asset into the export (localized at the UI). */
export type AudioAssetLabel =
  | { kind: 'frozen-track'; name: string }
  | { kind: 'audio-clip'; name: string };

/** A condition that must be fixed before rendering (localized at the UI). */
export type AudioExportBlocker =
  | { kind: 'audio-clip-no-media'; clip: string; track: string }
  | { kind: 'media-missing'; labels: AudioAssetLabel[]; assetId: string; reason: string }
  | { kind: 'soundfont-missing'; fontId: string; reason: string };

/** A fidelity limitation the user may explicitly accept (localized at the UI). */
export type AudioExportWarning =
  | { kind: 'external-midi-silent'; track: string }
  | { kind: 'release-tail-short'; currentSeconds: number; suggestedSeconds: number }
  | { kind: 'solo-active'; tracks: string[] }
  | { kind: 'return-solo-active'; buses: string[] }
  | { kind: 'silent-mixdown' };

export interface AudioExportPreflightResult {
  /** Conditions that must be fixed before starting the expensive render. */
  blockers: AudioExportBlocker[];
  /** Known fidelity limitations the user may explicitly accept. */
  warnings: AudioExportWarning[];
}

export interface AudioExportPreflightOptions {
  /** Release tail selected for a project-range export. */
  releaseTailSeconds: number;
  /** Explicit loop ranges do not append a release tail. */
  range: 'project' | 'loop';
  /** Required PPQ window when range is `loop`. */
  loopRegion?: MixdownRangePpq | null;
  /** Whether master-strip and mastering-chain inserts are rendered; defaults to true. */
  includeMasterChain?: boolean;
  /** Injectable insert tail lookup; defaults to the engine's insert timing query. */
  insertTail?: InsertTailResolver;
  /** Injectable payload validation seam; defaults to an OPFS size/sidecar check. */
  validateAudioAssetPayload?: (assetId: string) => Promise<AudioAssetMeta>;
  /** Injectable SoundFont loader; defaults to the project font store. */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** @deprecated Payload validation is required; retained only as a test seam. */
  loadAudioAssetMeta?: (assetId: string) => Promise<AudioAssetMeta>;
  /** @deprecated Use loadAudioAssetMeta; retained for callers that need a custom seam. */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  signal?: AbortSignal;
}

interface AssetUse {
  id: string;
  /** Labels keyed by `${kind}:${name}` so repeated references stay de-duplicated. */
  labels: Map<string, AudioAssetLabel>;
}

function isMidiClip(clip: ProjectDocument['tracks'][number]['clips'][number]): boolean {
  return (clip.kind ?? 'midi') === 'midi';
}

export interface TimeEffectSlotOptions {
  /** Include return/output-bus inserts that belong to an audible route. */
  includeBuses?: boolean;
  /** Include master-strip inserts. */
  includeMaster?: boolean;
  /** Include the offline mastering-chain processors. */
  includeMastering?: boolean;
}

/** Enabled inserts grouped by the signal stage they sit in. */
interface ActiveInsertStages {
  /** One chain per audible lane or group strip; lanes run in parallel. */
  lanes: InsertSlot[][];
  /** One chain per bus entry point, through every bus it routes on into; entries run in parallel. */
  buses: InsertSlot[][];
  master: InsertSlot[];
  mastering: InsertSlot[];
}

/** Resolves the audible tail of one insert slot, in seconds. */
export type InsertTailResolver = (slot: Pick<InsertSlot, 'processor' | 'params'>) => number;

/** Catalog fields needed to derive an insert's tail. */
export interface InsertTailCatalogEntry {
  id: string;
  /** Tail the processor reports at its default parameters and 48 kHz. */
  tailSamples?: number;
  /** Parameter keys; an absent id marks one the insert reads only while it is built. */
  params?: ReadonlyArray<{ name: string; id?: number }>;
}

/** Engine query for the tail a configured insert reports (masteringInsertTiming). */
export type InsertTailTimingQuery = (request: {
  insert: MasteringInsertName;
  params: Record<string, InsertParamValue>;
  sampleRate: number;
}) => { tailSamples: number };

function tailSecondsFromSamples(samples: unknown, sampleRate: number): number {
  if (typeof samples !== 'number' || !Number.isFinite(samples) || samples <= 0) return 0;
  return Math.min(MAX_RELEASE_TAIL_SECONDS, samples / sampleRate);
}

/**
 * Builds a resolver that asks the engine what tail each configured insert
 * reports. The full parameter set is tried first; when the engine refuses a
 * key that is only patched live, the build-time keys alone are tried, and
 * finally the catalog's default tail stands in. Unknown processors have none.
 */
export function insertTailResolverFromTiming(
  entries: ReadonlyArray<InsertTailCatalogEntry> | null | undefined,
  sampleRate: number,
  timing: InsertTailTimingQuery,
): InsertTailResolver {
  const byProcessor = new Map((entries ?? []).map((entry) => [entry.id, entry]));
  const answers = new Map<string, number>();
  const ask = (processor: string, params: Record<string, InsertParamValue>): number | undefined => {
    try {
      return tailSecondsFromSamples(
        timing({ insert: processor as MasteringInsertName, params, sampleRate }).tailSamples,
        sampleRate,
      );
    } catch {
      return undefined;
    }
  };
  return (slot) => {
    const entry = byProcessor.get(slot.processor);
    if (!entry) return 0;
    const params: Record<string, InsertParamValue> = {};
    for (const [key, value] of Object.entries(slot.params).sort(([a], [b]) => a.localeCompare(b))) {
      if (isInsertParamValue(value)) params[key] = value;
    }
    const cacheKey = `${slot.processor}|${JSON.stringify(params)}`;
    let tail = answers.get(cacheKey);
    if (tail === undefined) {
      const buildKeys = new Set(
        (entry.params ?? []).filter((param) => param.id === undefined).map((param) => param.name),
      );
      const buildParams = Object.fromEntries(
        Object.entries(params).filter(([key]) => buildKeys.has(key)),
      );
      tail =
        ask(slot.processor, params) ??
        ask(slot.processor, buildParams) ??
        tailSecondsFromSamples(entry.tailSamples, sampleRate);
      answers.set(cacheKey, tail);
    }
    return tail;
  };
}

/** Groups the enabled inserts of the audible signal path by stage. */
function activeInsertStages(
  doc: ProjectDocument,
  audibleTrackIndices: ReadonlySet<number>,
  options: TimeEffectSlotOptions,
): ActiveInsertStages {
  const { includeBuses = true, includeMaster = true, includeMastering = true } = options;
  const enabled = (slots: ReadonlyArray<InsertSlot> | undefined): InsertSlot[] =>
    (slots ?? []).filter((slot) => slot.enabled);
  const stages: ActiveInsertStages = { lanes: [], buses: [], master: [], mastering: [] };
  const entryBusIds = new Set<string>();
  doc.tracks.forEach((track, index) => {
    const carriesAudibleMember =
      track.kind === 'group' &&
      doc.tracks.some(
        (member, memberIndex) =>
          member.groupIndex === index && audibleTrackIndices.has(memberIndex),
      );
    if (!audibleTrackIndices.has(index) && !carriesAudibleMember) return;
    stages.lanes.push(enabled(track.mixer?.inserts));
    if (includeBuses) {
      const outputBusId = audibleOutputBusId(track);
      if (outputBusId) entryBusIds.add(outputBusId);
      for (const send of track.mixer?.sends ?? []) {
        if (send.enabled) entryBusIds.add(send.busId);
      }
    }
  });
  if (includeMaster) stages.master = enabled(doc.mixer?.master.inserts);
  if (includeBuses) {
    // A bus that routes into another bus puts both chains in series.
    const busesById = new Map((doc.mixer?.buses ?? []).map((bus) => [bus.id, bus]));
    for (const busId of entryBusIds) {
      if (!busesById.has(busId)) continue;
      stages.buses.push(
        busOutputChain(busId, busesById).flatMap((bus) => enabled(bus.strip?.inserts)),
      );
    }
  }
  if (includeMastering) stages.mastering = enabled(doc.mixer?.masteringChain?.processors);
  return stages;
}

/**
 * Estimates the release tail of the audible signal path in seconds: the
 * longest lane chain, then the longest bus chain, then the master and
 * mastering chains, each chain summing its inserts' tails.
 */
export function estimatedTailSeconds(
  doc: ProjectDocument,
  audibleTrackIndices: ReadonlySet<number>,
  resolveTail: InsertTailResolver,
  options: TimeEffectSlotOptions = {},
): number {
  const stages = activeInsertStages(doc, audibleTrackIndices, options);
  const chain = (slots: ReadonlyArray<InsertSlot>): number =>
    slots.reduce((sum, slot) => sum + resolveTail(slot), 0);
  const longest = (chains: ReadonlyArray<ReadonlyArray<InsertSlot>>): number =>
    Math.max(0, ...chains.map(chain));
  const total =
    longest(stages.lanes) + longest(stages.buses) + chain(stages.master) + chain(stages.mastering);
  return Math.min(MAX_RELEASE_TAIL_SECONDS, total);
}

/** Resolves insert tails through the loaded WASM module, or null when it is unavailable. */
async function wasmInsertTailResolver(sampleRate: number): Promise<InsertTailResolver | null> {
  try {
    const { ensureWasm } = await import('@/lib/wasm');
    const wasm = await ensureWasm();
    return insertTailResolverFromTiming(
      wasm.masteringProcessorCatalog(),
      sampleRate,
      wasm.masteringInsertTiming,
    );
  } catch {
    return null;
  }
}

function resolvePreflightRange(options: AudioExportPreflightOptions): RenderPpqRange {
  if (options.range === 'project') return { startPpq: 0, endPpq: null };
  const loop = options.loopRegion;
  if (
    !loop ||
    !Number.isFinite(loop.startPpq) ||
    loop.startPpq < 0 ||
    !Number.isFinite(loop.endPpq) ||
    loop.endPpq <= loop.startPpq
  ) {
    throw new RangeError("Audio export preflight range 'loop' requires a valid loopRegion");
  }
  return { startPpq: loop.startPpq, endPpq: loop.endPpq };
}

function trackTimelineIntersectsRange(
  track: ProjectDocument['tracks'][number],
  range: RenderPpqRange,
): boolean {
  return (
    track.clips.length === 0 ||
    track.clips.some((clip) => ppqSpanIntersectsRange(clip.startPpq, clip.lengthPpq, range))
  );
}

/**
 * Validates media referenced by audible audio/frozen content and reports
 * offline-only losses before rendering. It checks both the lightweight asset
 * sidecar and the PCM file size, without decoding PCM; the renderer remains
 * responsible for its worker-side decode.
 */
export async function audioExportPreflight(
  input: ProjectDocument,
  options: AudioExportPreflightOptions,
): Promise<AudioExportPreflightResult> {
  const doc = programOutputDocument(input);
  const blockers: AudioExportBlocker[] = [];
  const warnings: AudioExportWarning[] = [];
  const range = resolvePreflightRange(options);
  const tempoMap = normalizeTempoMap(documentTempoSegments(doc));
  // Inserts only matter for the tail (and preroll) when some track can carry one.
  const tailOptions: TimeEffectSlotOptions = {
    includeMaster: options.includeMasterChain ?? true,
    includeMastering: options.includeMasterChain ?? true,
  };
  const everyTrack = new Set(doc.tracks.map((_, index) => index));
  const anyInserts = activeInsertStages(doc, everyTrack, {});
  const resolveTail = [
    ...anyInserts.lanes,
    ...anyInserts.buses,
    anyInserts.master,
    anyInserts.mastering,
  ].some((chain) => chain.length > 0)
    ? (options.insertTail ?? (await wasmInsertTailResolver(doc.sampleRate)))
    : null;
  const plan = planExportRender({
    doc,
    sampleRate: doc.sampleRate,
    tempoMap,
    range,
    estimateTailSeconds: (contributors) =>
      resolveTail ? estimatedTailSeconds(doc, contributors, resolveTail, tailOptions) : 0,
  });
  const { audibleTrackIndices, contributorTrackIndices, contributionRange } = plan;
  const vcaControls = new Map((doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group]));
  const soloTracks = tracksWithVcaSolo(doc.tracks, vcaControls).filter((track) => track.solo);
  if (soloTracks.length > 0) {
    warnings.push({ kind: 'solo-active', tracks: soloTracks.map((track) => track.name) });
  }
  const soloBuses = (doc.mixer?.buses ?? []).filter((bus) => bus.solo === true);
  if (soloBuses.length > 0) {
    warnings.push({ kind: 'return-solo-active', buses: soloBuses.map((bus) => bus.name) });
  }
  if (doc.tracks.length > 0 && audibleTrackIndices.size === 0) {
    warnings.push({ kind: 'silent-mixdown' });
  }
  const uses = new Map<string, AssetUse>();
  const addUse = (id: string, label: AudioAssetLabel): void => {
    const use = uses.get(id) ?? { id, labels: new Map<string, AudioAssetLabel>() };
    use.labels.set(`${label.kind}:${label.name}`, label);
    uses.set(id, use);
  };

  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex += 1) {
    options.signal?.throwIfAborted();
    if (!contributorTrackIndices.has(trackIndex)) continue;
    const track = doc.tracks[trackIndex];
    if (track.frozen !== undefined) {
      if (trackTimelineIntersectsRange(track, contributionRange)) {
        addUse(track.frozen.assetId, { kind: 'frozen-track', name: track.name });
      }
      continue;
    }

    const instrument = effectiveTrackInstrument(track, doc.externalMidiDefault);
    if (
      audibleTrackIndices.has(trackIndex) &&
      track.kind === 'midi' &&
      instrument.kind === 'external-midi' &&
      track.clips.some(
        (clip) =>
          isMidiClip(clip) &&
          clip.gain > 0 &&
          clip.notes.length > 0 &&
          ppqSpanIntersectsRange(clip.startPpq, clip.lengthPpq, range),
      )
    ) {
      warnings.push({ kind: 'external-midi-silent', track: track.name });
    }

    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') !== 'audio' || clip.gain <= 0 || clip.lengthPpq <= 0) continue;
      if (!ppqSpanIntersectsRange(clip.startPpq, clip.lengthPpq, contributionRange)) continue;
      const segments = audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq });
      if (segments.length === 0) {
        blockers.push({ kind: 'audio-clip-no-media', clip: clip.name, track: track.name });
        continue;
      }
      for (const segment of segments) {
        const segmentStartPpq = clip.startPpq + segment.offsetPpq;
        if (!ppqSpanIntersectsRange(segmentStartPpq, segment.lengthPpq, contributionRange))
          continue;
        addUse(segment.assetId, { kind: 'audio-clip', name: clip.name });
      }
    }
  }

  const validateAudio =
    options.validateAudioAssetPayload ??
    options.loadAudioAssetMeta ??
    options.loadAudioAsset ??
    validateAssetPayload;
  for (const use of uses.values()) {
    options.signal?.throwIfAborted();
    try {
      await validateAudio(use.id);
    } catch (error) {
      options.signal?.throwIfAborted();
      const reason = errorMessage(error);
      blockers.push({
        kind: 'media-missing',
        labels: [...use.labels.values()],
        assetId: use.id,
        reason,
      });
    }
  }

  const readFont = options.loadFont ?? loadFont;
  for (const fontId of plan.soundFontUsage.fontIds) {
    options.signal?.throwIfAborted();
    try {
      await readFont(fontId);
    } catch (error) {
      options.signal?.throwIfAborted();
      blockers.push({
        kind: 'soundfont-missing',
        fontId,
        reason: errorMessage(error),
      });
    }
  }

  if (options.range === 'project') {
    const tail = resolveTail
      ? estimatedTailSeconds(doc, contributorTrackIndices, resolveTail, tailOptions)
      : 0;
    if (tail > options.releaseTailSeconds) {
      warnings.push({
        kind: 'release-tail-short',
        currentSeconds: options.releaseTailSeconds,
        suggestedSeconds: tail,
      });
    }
  }

  return { blockers, warnings };
}

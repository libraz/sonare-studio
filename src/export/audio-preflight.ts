/** Audio-export preflight for omissions that would otherwise become silence. */

import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  validateAssetPayload,
} from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import { effectiveTrackInstrument } from '@/project/instrument';
import type { InsertSlot } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import {
  documentAudibleTrackIndices,
  ppqSpanIntersectsRange,
  type RenderPpqRange,
} from './engine-render-context';
import type { MixdownRangePpq } from './mixdown';

/** Structured reference to what pulled an asset into the export (localized at the UI). */
export type AudioAssetLabel =
  | { kind: 'frozen-track'; name: string }
  | { kind: 'audio-clip'; name: string };

/** A condition that must be fixed before rendering (localized at the UI). */
export type AudioExportBlocker =
  | { kind: 'audio-clip-no-media'; clip: string; track: string }
  | { kind: 'media-missing'; labels: AudioAssetLabel[]; assetId: string; reason: string };

/** A fidelity limitation the user may explicitly accept (localized at the UI). */
export type AudioExportWarning =
  | { kind: 'external-midi-silent'; track: string }
  | { kind: 'release-tail-short'; currentSeconds: number; suggestedSeconds: number };

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
  /** Injectable payload validation seam; defaults to an OPFS size/sidecar check. */
  validateAudioAssetPayload?: (assetId: string) => Promise<AudioAssetMeta>;
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

function activeTimeEffectSlots(
  doc: ProjectDocument,
  audibleTrackIndices: ReadonlySet<number>,
): InsertSlot[] {
  const slots: InsertSlot[] = [];
  const activeBusIds = new Set<string>();
  doc.tracks.forEach((track, index) => {
    const carriesAudibleMember =
      track.kind === 'group' &&
      doc.tracks.some(
        (member, memberIndex) =>
          member.groupIndex === index && audibleTrackIndices.has(memberIndex),
      );
    if (!audibleTrackIndices.has(index) && !carriesAudibleMember) return;
    slots.push(...(track.mixer?.inserts ?? []));
    if (track.mixer?.outputBusId) activeBusIds.add(track.mixer.outputBusId);
    for (const send of track.mixer?.sends ?? []) {
      if (send.enabled) activeBusIds.add(send.busId);
    }
  });
  slots.push(...(doc.mixer?.master.inserts ?? []));
  for (const bus of doc.mixer?.buses ?? []) {
    if (activeBusIds.has(bus.id)) slots.push(...(bus.strip?.inserts ?? []));
  }
  slots.push(...(doc.mixer?.masteringChain?.processors ?? []));
  return slots.filter((slot) => slot.enabled && /(?:reverb|delay|echo)/i.test(slot.processor));
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

function suggestedTailSeconds(slots: ReadonlyArray<InsertSlot>): number {
  let suggested = slots.length > 0 ? 5 : 0;
  for (const slot of slots) {
    for (const [name, value] of Object.entries(slot.params)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      if (/(?:decay|release|tail)(?:Seconds|Sec)$/i.test(name))
        suggested = Math.max(suggested, value);
      if (/(?:decay|release|tail)(?:Milliseconds|Ms)$/i.test(name)) {
        suggested = Math.max(suggested, value / 1000);
      }
    }
  }
  return suggested;
}

/**
 * Validates media referenced by audible audio/frozen content and reports
 * offline-only losses before rendering. It checks both the lightweight asset
 * sidecar and the PCM file size, without decoding PCM; the renderer remains
 * responsible for its worker-side decode.
 */
export async function audioExportPreflight(
  doc: ProjectDocument,
  options: AudioExportPreflightOptions,
): Promise<AudioExportPreflightResult> {
  const blockers: AudioExportBlocker[] = [];
  const warnings: AudioExportWarning[] = [];
  const range = resolvePreflightRange(options);
  const audibleTrackIndices = documentAudibleTrackIndices(doc);
  const uses = new Map<string, AssetUse>();
  const addUse = (id: string, label: AudioAssetLabel): void => {
    const use = uses.get(id) ?? { id, labels: new Map<string, AudioAssetLabel>() };
    use.labels.set(`${label.kind}:${label.name}`, label);
    uses.set(id, use);
  };

  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex += 1) {
    options.signal?.throwIfAborted();
    if (!audibleTrackIndices.has(trackIndex)) continue;
    const track = doc.tracks[trackIndex];
    if (track.frozen !== undefined) {
      if (trackTimelineIntersectsRange(track, range)) {
        addUse(track.frozen.assetId, { kind: 'frozen-track', name: track.name });
      }
      continue;
    }

    const instrument = effectiveTrackInstrument(track, doc.externalMidiDefault);
    if (
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
      if (!ppqSpanIntersectsRange(clip.startPpq, clip.lengthPpq, range)) continue;
      const segments = audioClipSegments(clip);
      if (segments.length === 0) {
        blockers.push({ kind: 'audio-clip-no-media', clip: clip.name, track: track.name });
        continue;
      }
      for (const segment of segments) {
        const segmentStartPpq = clip.startPpq + segment.offsetPpq;
        if (!ppqSpanIntersectsRange(segmentStartPpq, segment.lengthPpq, range)) continue;
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
      const reason = error instanceof Error ? error.message : String(error);
      blockers.push({
        kind: 'media-missing',
        labels: [...use.labels.values()],
        assetId: use.id,
        reason,
      });
    }
  }

  if (options.range === 'project') {
    const tail = suggestedTailSeconds(activeTimeEffectSlots(doc, audibleTrackIndices));
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

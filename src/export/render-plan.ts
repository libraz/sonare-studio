/**
 * Render plan shared by the audio-export preflight and the engine renderer:
 * the contributor tracks, the stateful-DSP preroll window and the SoundFonts
 * the render will load, derived once from the document before any render work.
 */

import type { ScheduledMidiClip } from '@/engine/midi-sync';
import { effectiveTrackInstrument } from '@/project/instrument';
import type { ProjectDocument } from '@/project/serialization';
import {
  type ActiveSoundFontUsage,
  collectActiveSoundFontUsage,
} from '@/project/soundfont-conflicts';
import {
  DEFAULT_TEMPO_BPM,
  type NormalizedTempoMap,
  ppqToSamples,
  preserveLegacyTempoSegmentFloor,
  samplesToPpq,
} from '@/project/tempo-map';
import type { TempoSegment } from '@/project/types';
import {
  activeMidiTrackIndicesForRange,
  buildMidiSchedules,
  documentAudibleTrackIndices,
  documentRenderContributorIndices,
  type RenderPpqRange,
} from './engine-render-context';
import { MAX_PREROLL_SECONDS, PREROLL_SECONDS } from './engine-render-types';

export interface ExportRenderPlanInput {
  /** Program-output document (see `programOutputDocument`). */
  doc: ProjectDocument;
  sampleRate: number;
  tempoMap: NormalizedTempoMap;
  /** Requested capture window. */
  range: RenderPpqRange;
  /** Track rendered even when muted (freeze bounce). */
  freezeTrackIndex?: number;
  /** Release tail of the signal path made of the given contributor tracks. */
  estimateTailSeconds: (contributorTrackIndices: ReadonlySet<number>) => number;
}

export interface ExportRenderPlan {
  /** Synthetic engine track ids, one per document track. */
  trackIds: number[];
  /** Tracks that reach the master through mute/solo/group gates. */
  audibleTrackIndices: Set<number>;
  /** Tracks whose media the render loads (audible plus pre-gate send/sidechain sources). */
  contributorTrackIndices: Set<number>;
  /** Stateful-DSP history rendered and discarded before capture. */
  prerollSeconds: number;
  /** Capture window extended back by the preroll; media outside it is not loaded. */
  contributionRange: RenderPpqRange;
  midiSchedules: ScheduledMidiClip[];
  /** Contributor MIDI tracks with a sounding note inside the contribution window. */
  activeMidiTrackIndices: Set<number>;
  /** SoundFonts used by the active MIDI tracks. */
  soundFontUsage: ActiveSoundFontUsage;
}

/** Tempo segments of a document, defaulting to a constant tempo when it has none. */
export function documentTempoSegments(doc: ProjectDocument): TempoSegment[] {
  return doc.tempoSegments.length > 0
    ? doc.tempoSegments.map(preserveLegacyTempoSegmentFloor)
    : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
}

/**
 * Derives everything the render and its preflight must agree on. Both call
 * this, so a track or font one of them needs is by construction one the other
 * checks.
 */
export function planExportRender(input: ExportRenderPlanInput): ExportRenderPlan {
  const { doc, sampleRate, tempoMap, range } = input;
  const trackIds = doc.tracks.map((_, index) => index + 1);
  const audibleTrackIndices = documentAudibleTrackIndices(doc);
  if (input.freezeTrackIndex !== undefined) audibleTrackIndices.add(input.freezeTrackIndex);
  const contributorTrackIndices = documentRenderContributorIndices(doc, audibleTrackIndices);
  const prerollSeconds = Math.min(
    MAX_PREROLL_SECONDS,
    Math.max(PREROLL_SECONDS, input.estimateTailSeconds(contributorTrackIndices)),
  );
  const renderStartSample = ppqToSamples(tempoMap, range.startPpq, sampleRate);
  const prerollFrames = Math.min(renderStartSample, Math.round(prerollSeconds * sampleRate));
  const contributionRange = {
    startPpq: samplesToPpq(tempoMap, renderStartSample - prerollFrames, sampleRate),
    endPpq: range.endPpq,
  };

  // Exact compiled note intervals decide which fonts can contribute.
  const midiSchedules = buildMidiSchedules(doc, trackIds, documentTempoSegments(doc), sampleRate);
  const activeMidiTrackIndices = activeMidiTrackIndicesForRange(
    midiSchedules,
    trackIds,
    contributorTrackIndices,
    renderStartSample - prerollFrames,
    range.endPpq === null
      ? Number.POSITIVE_INFINITY
      : ppqToSamples(tempoMap, range.endPpq, sampleRate),
  );
  const soundFontUsage = collectActiveSoundFontUsage(
    doc.tracks
      .map((track) => ({
        ...track,
        instrument:
          track.kind === 'midi'
            ? effectiveTrackInstrument(track, doc.externalMidiDefault)
            : undefined,
      }))
      .filter((_track, index) => activeMidiTrackIndices.has(index)),
  );
  return {
    trackIds,
    audibleTrackIndices,
    contributorTrackIndices,
    prerollSeconds,
    contributionRange,
    midiSchedules,
    activeMidiTrackIndices,
    soundFontUsage,
  };
}

/**
 * Cross-track arrangement analysis for the arrangement view: conflicts (notes
 * clashing with the sounding harmony), a coarse tension curve, and the piece's
 * phrase structure, derived from the whole project.
 *
 * The analysis walks every track and pools their notes, so it is comparatively
 * expensive; unlike the piano-roll guidance it does NOT run as a live computed.
 * The caller triggers {@link ArrangementAnalysis.analyze} explicitly (an
 * "Analyze" action, or a debounced edit-stop), and the results sit in refs
 * until the next run. This keeps playback and routine edits free of a full
 * multi-track sweep (see the arrangement-analysis performance note in the
 * integration plan).
 */

import { type Ref, ref } from 'vue';
import { type ArrangementConflict, analyzeArrangementWithTension } from '@/compose/arrangement';
import { effectiveKeyScale } from '@/compose/key';
import { analyzeMotifs, type TrackMotifs } from '@/compose/motifs';
import {
  analyzePhrases,
  type DetectedPhrase,
  type HypermeterReading,
  type RankedCadence,
} from '@/compose/phrases';
import type { TrackWithNotes } from '@/compose/tracks';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';

/** One tension sample positioned in absolute PPQ. */
export interface TensionSample {
  /** Absolute PPQ of the sample (== libcantus beat). */
  ppq: number;
  /** Combined harmonic tension in [0, 1]. */
  tension: number;
}

/** The on-demand arrangement-analysis surface. */
export interface ArrangementAnalysis {
  /** Notes clashing with the sounding harmony, worst severity first. */
  conflicts: Ref<ArrangementConflict[]>;
  /** Harmonic-tension samples across the piece. */
  tension: Ref<TensionSample[]>;
  /** Phrases in time order; they abut and cover the piece. */
  phrases: Ref<DetectedPhrase[]>;
  /** The cadences closing those phrases, heaviest first. */
  cadences: Ref<RankedCadence[]>;
  /** How the piece's bars group above the bar line, or null when unread. */
  hypermeter: Ref<HypermeterReading | null>;
  /** The figures each part restates, one entry per track that states one. */
  motifs: Ref<TrackMotifs[]>;
  /**
   * True when the piece holds more notes than the phrase reading can compare,
   * so it has no phrases or cadences while the rest of the run still stands.
   */
  tooLongForPhrases: Ref<boolean>;
  /** Names of percussion tracks dropped from analysis (shown so exclusion is visible). */
  excludedTrackNames: Ref<string[]>;
  /** True once {@link analyze} has run at least once since the last reset. */
  analyzed: Ref<boolean>;
  /** Recomputes the analysis from the current project state. */
  analyze: (tensionStep?: number) => void;
  /** Clears the cached results. */
  reset: () => void;
}

/**
 * Builds each track paired with its notes flattened across its clips to
 * absolute-timeline PPQ (percussion exclusion happens inside the adapter).
 */
function collectTracks(store: ReturnType<typeof useProjectStore>): TrackWithNotes[] {
  const out: TrackWithNotes[] = [];
  for (const track of store.tracks) {
    const clips = store.clipsByTrack.get(track.id) ?? [];
    const notes = clips.flatMap(projectMidiNoteOccurrences);
    out.push({ track, notes });
  }
  return out;
}

/** Creates the on-demand arrangement-analysis surface for the current project. */
export function useArrangementAnalysis(): ArrangementAnalysis {
  const store = useProjectStore();
  const conflicts = ref<ArrangementConflict[]>([]);
  const tension = ref<TensionSample[]>([]);
  const phrases = ref<DetectedPhrase[]>([]);
  const cadences = ref<RankedCadence[]>([]);
  const hypermeter = ref<HypermeterReading | null>(null);
  const motifs = ref<TrackMotifs[]>([]);
  const tooLongForPhrases = ref(false);
  const excludedTrackNames = ref<string[]>([]);
  const analyzed = ref(false);

  function analyze(tensionStep = 1): void {
    const tracks = collectTracks(store);
    const key = store.scaleHighlight.enabled ? effectiveKeyScale(store.scaleHighlight) : undefined;
    // Conflicts and tension are read off one sweep; the analysis behind them is
    // the expensive part and asking for it twice doubled the cost of a run.
    const report = analyzeArrangementWithTension(tracks, tensionStep, key, store.timeSignatures);
    conflicts.value = report.conflicts;
    excludedTrackNames.value = report.excludedTrackNames;
    tension.value = report.tension.map((point) => ({ ppq: point.beat, tension: point.tension }));
    // Phrasing follows the written chord track when there is one, so it reads
    // the harmony the composer stated rather than a re-reading of it.
    const structure = analyzePhrases(tracks, store.chords, store.timeSignatures);
    phrases.value = structure.phrases;
    cadences.value = structure.cadences;
    hypermeter.value = structure.hypermeter;
    tooLongForPhrases.value = structure.tooLongForPhrases;
    // Motifs are read per track: a figure lives in one part, and pooling the
    // parts would report a cell nobody plays.
    motifs.value = analyzeMotifs(tracks, key).tracks;
    analyzed.value = true;
  }

  function reset(): void {
    conflicts.value = [];
    tension.value = [];
    phrases.value = [];
    cadences.value = [];
    hypermeter.value = null;
    motifs.value = [];
    tooLongForPhrases.value = false;
    excludedTrackNames.value = [];
    analyzed.value = false;
  }

  return {
    conflicts,
    tension,
    phrases,
    cadences,
    hypermeter,
    motifs,
    tooLongForPhrases,
    excludedTrackNames,
    analyzed,
    analyze,
    reset,
  };
}

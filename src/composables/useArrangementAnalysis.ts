/**
 * Cross-track arrangement analysis for the arrangement view: conflicts (notes
 * clashing with the sounding harmony) and a coarse tension curve, derived from
 * the whole project.
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
import {
  type ArrangementConflict,
  analyzeArrangementTracks,
  arrangementTensionCurve,
} from '@/compose/arrangement';
import { effectiveKeyScale } from '@/compose/key';
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
  const excludedTrackNames = ref<string[]>([]);
  const analyzed = ref(false);

  function analyze(tensionStep = 1): void {
    const tracks = collectTracks(store);
    const key = store.scaleHighlight.enabled ? effectiveKeyScale(store.scaleHighlight) : undefined;
    const report = analyzeArrangementTracks(tracks, key, store.timeSignatures);
    conflicts.value = report.conflicts;
    excludedTrackNames.value = report.excludedTrackNames;
    tension.value = arrangementTensionCurve(tracks, tensionStep, key, store.timeSignatures).map(
      (point) => ({ ppq: point.beat, tension: point.tension }),
    );
    analyzed.value = true;
  }

  function reset(): void {
    conflicts.value = [];
    tension.value = [];
    excludedTrackNames.value = [];
    analyzed.value = false;
  }

  return { conflicts, tension, excludedTrackNames, analyzed, analyze, reset };
}

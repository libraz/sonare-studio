/**
 * Reactive reharmonization commands: build a melody-first reharmonization
 * proposal for the active clip, and commit an approved one as a single undoable
 * edit.
 *
 * The proposal itself is pure ({@link proposeReactiveReharmonization}); this
 * layer only gathers the store inputs (the current chord track, the active
 * clip's melody on the absolute timeline, key and meter) and writes an approved
 * result back through {@link setProjectChords} (one history entry). The proposal
 * is ephemeral until the composer approves it — nothing is mutated when it is
 * only computed.
 */

import {
  type LockedRegion,
  proposeReactiveReharmonization,
  type ReharmonizationProposal,
} from '@/compose/reharmonize-reactive';
import { topVoiceOnly } from '@/compose/tracks';
import { useProjectStore } from '../store';
import { setProjectChords } from './chords';
import type { ReharmonizeStrength } from './generate-harmonize';

/** Options for {@link proposeReharmonizationForActiveClip}. */
export interface ReactiveReharmonizeParams {
  /** Region touched by the edit that triggered the pass, in absolute PPQ. */
  editedSpan: { startPpq: number; endPpq: number };
  /** Progression spans the composer has locked (inviolable). */
  locked?: ReadonlyArray<LockedRegion>;
  /** Candidate-pool strength (default 'diatonic'). */
  reharmonize?: ReharmonizeStrength;
}

/**
 * Computes a reactive reharmonization proposal for the active clip's melody,
 * without mutating anything.
 *
 * @param params The edited span, locked regions and reharmonization strength.
 * @returns The proposal, or null when there is no active clip.
 */
export function proposeReharmonizationForActiveClip(
  params: ReactiveReharmonizeParams,
): ReharmonizationProposal | null {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (clip === null) return null;

  // Reduce the clip to its top voice, then shift onto the absolute timeline so
  // the melody lines up with the (absolute-PPQ) chord track.
  const events = clip.notes.map((note) => ({
    pitch: note.pitch,
    startBeat: note.startPpq,
    durationBeat: note.durationPpq,
  }));
  const melody = topVoiceOnly(events).map((event) => ({
    pitch: event.pitch,
    startPpq: event.startBeat + clip.startPpq,
    durationPpq: event.durationBeat,
  }));

  return proposeReactiveReharmonization({
    current: store.chords,
    melody,
    editedSpan: params.editedSpan,
    ...(params.locked !== undefined ? { locked: params.locked } : {}),
    key: store.scaleHighlight,
    timeSignatures: store.timeSignatures,
    ...(params.reharmonize !== undefined ? { reharmonize: params.reharmonize } : {}),
  });
}

/**
 * Commits an approved reharmonization proposal to the chord track as one
 * undoable edit. A proposal that changes nothing is a no-op.
 *
 * @param proposal The proposal returned by {@link proposeReharmonizationForActiveClip}.
 */
export function applyReharmonizationProposal(proposal: ReharmonizationProposal): void {
  if (!proposal.changed) return;
  setProjectChords(proposal.proposal);
}

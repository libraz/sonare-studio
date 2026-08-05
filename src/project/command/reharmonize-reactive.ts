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
import { canonicalJson, fnv1a32Hex } from '../hash';
import { projectMidiNoteOccurrences } from '../midi-projection';
import { useProjectStore } from '../store';
import { measureRangeAt } from '../time-signature';
import { setProjectChords } from './chords';
import type { ReharmonizeStrength } from './generate-harmonize';
import { requireEditableClip } from './utils';

/** Options for {@link proposeReharmonizationForActiveClip}. */
export interface ReactiveReharmonizeParams {
  /**
   * Region(s) touched by the edit that triggered the pass, in absolute PPQ. A
   * looping clip passes one span per loop occurrence.
   */
  editedSpan:
    | { startPpq: number; endPpq: number }
    | ReadonlyArray<{ startPpq: number; endPpq: number }>;
  /** Progression spans the composer has locked (inviolable). */
  locked?: ReadonlyArray<LockedRegion>;
  /** Candidate-pool strength (default 'diatonic'). */
  reharmonize?: ReharmonizeStrength;
}

/** Store-bound proposal carrying the exact context it was computed against. */
export interface ProjectReharmonizationProposal extends ReharmonizationProposal {
  contextHash: string;
}

/** Hashes every mutable input that can invalidate a pending proposal. */
export function reharmonizationContextHash(locked: ReadonlyArray<LockedRegion> = []): string {
  const store = useProjectStore();
  const clip = store.activeClip;
  return fnv1a32Hex(
    canonicalJson({
      clipId: store.clipId,
      clip:
        clip === null
          ? null
          : {
              startPpq: clip.startPpq,
              lengthPpq: clip.lengthPpq,
              sourceOffsetPpq: clip.sourceOffsetPpq,
              loopEnabled: clip.loopEnabled,
              loopLengthPpq: clip.loopLengthPpq,
              notes: clip.notes,
            },
      chords: store.chords,
      key: store.scaleHighlight,
      timeSignatures: store.timeSignatures,
      locked: [...locked].sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq),
    }),
  );
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
): ProjectReharmonizationProposal | null {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (clip === null) return null;

  // Reduce the clip to its top voice, then shift onto the absolute timeline so
  // the melody lines up with the (absolute-PPQ) chord track.
  const events = projectMidiNoteOccurrences(clip).map((note) => ({
    pitch: note.pitch,
    startBeat: note.startPpq,
    durationBeat: note.durationPpq,
  }));
  const melody = topVoiceOnly(events).map((event) => ({
    pitch: event.pitch,
    startPpq: event.startBeat,
    durationPpq: event.durationBeat,
  }));

  const locked = params.locked ?? [];
  const proposal = proposeReactiveReharmonization({
    current: store.chords,
    melody,
    editedSpan: params.editedSpan,
    ...(params.locked !== undefined ? { locked: params.locked } : {}),
    key: store.scaleHighlight,
    timeSignatures: store.timeSignatures,
    // Keep generated slots on the project's bar grid even when the active clip
    // starts on an upbeat or in the middle of a bar.
    harmonicGridOriginPpq: measureRangeAt(store.timeSignatures, clip.startPpq).startPpq,
    ...(params.reharmonize !== undefined ? { reharmonize: params.reharmonize } : {}),
  });
  return { ...proposal, contextHash: reharmonizationContextHash(locked) };
}

/**
 * Commits an approved reharmonization proposal to the chord track as one
 * undoable edit. A proposal that changes nothing is a no-op.
 *
 * @param proposal The proposal returned by {@link proposeReharmonizationForActiveClip}.
 */
export function applyReharmonizationProposal(
  proposal: ProjectReharmonizationProposal,
  locked: ReadonlyArray<LockedRegion> = [],
): boolean {
  const store = useProjectStore();
  if (store.activeClip !== null) requireEditableClip(store, store.activeClip.id);
  if (!proposal.changed || proposal.contextHash !== reharmonizationContextHash(locked))
    return false;
  setProjectChords(proposal.proposal);
  return true;
}

/**
 * Reactive reharmonization session for the piano roll: watches the active
 * clip's notes, and once an edit settles (a short quiet period) computes a
 * chord-track proposal scoped to the edited span. The proposal is held as
 * pending state for a non-blocking approval chip — it never mutates the
 * project until the composer applies it, and a new edit or a timeout
 * supersedes it silently.
 *
 * The whole behaviour is gated by the `pianoRollAutoReharmonize` user
 * preference (off by default), so composers opt in to reactive suggestions.
 * Locked chord regions live here as session-only state (not persisted): the
 * proposal pass treats them as inviolable.
 */

import { type ComputedRef, computed, onScopeDispose, type Ref, ref, watch } from 'vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import { useAppSettings } from '@/composables/useAppSettings';
import { useNoteNames } from '@/composables/useNoteNames';
import type { LockedRegion } from '@/compose/reharmonize-reactive';
import {
  changedNotesSpan,
  type HarmonicNoteSnapshot,
  isRegionLocked,
  snapshotNotes,
  toggleLockRegion,
} from '@/compose/reharmonize-session';
import { isDrumTrack } from '@/compose/tracks';
import { formatChordName } from '@/project/chords';
import {
  applyReharmonizationProposal,
  type ProjectReharmonizationProposal,
  proposeReharmonizationForActiveClip,
} from '@/project/commands';
import {
  audibleMidiSourceWindow,
  MAX_LOOP_OCCURRENCES,
  midiSourcePpqToTimeline,
} from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';

/** Quiet period after the last note edit before a proposal is computed. */
export const REHARMONIZE_SETTLE_MS = 700;

/** How long an unanswered suggestion stays up before dismissing itself. */
export const REHARMONIZE_AUTO_DISMISS_MS = 12000;

/** One chord the pending proposal would change, formatted for display. */
export interface PendingChordChange {
  /** Index into the sorted current chord track. */
  index: number;
  /** Current chord name (e.g. "Am7"). */
  from: string;
  /** Proposed chord name. */
  to: string;
}

export interface ReactiveReharmonization {
  /** The auto-suggest user preference (persisted, off by default). */
  autoReharmonize: Ref<boolean>;
  /** True when suggestions can run: preference on, MIDI clip active, chords present. */
  reharmonizeActive: ComputedRef<boolean>;
  /** The pending proposal awaiting approval, or null. */
  pendingProposal: Ref<ProjectReharmonizationProposal | null>;
  /** Display list of the chords the pending proposal changes. */
  pendingChanges: ComputedRef<PendingChordChange[]>;
  /** Commits the pending proposal as one undoable edit and clears it. */
  applyPendingProposal(): void;
  /** Discards the pending proposal. */
  dismissPendingProposal(): void;
  /** Session-only locked progression spans, in absolute PPQ. */
  lockedRegions: Ref<LockedRegion[]>;
  /** Toggles a lock over a chord region (overlapping locks are removed). */
  toggleLock(region: LockedRegion): void;
  /** Whether a chord region overlaps a locked span. */
  isLocked(region: LockedRegion): boolean;
}

/**
 * Creates the reactive-reharmonization session for the hosting editor.
 *
 * Call once from the piano-roll editor's setup; the debounce timers are
 * cleaned up with the component scope.
 */
export function useReactiveReharmonization(): ReactiveReharmonization {
  const store = useProjectStore();
  const appSettings = useAppSettings();
  const noteNames = useNoteNames();

  const autoReharmonize = computed<boolean>({
    get: () => appSettings.settings.pianoRollAutoReharmonize,
    set: (value: boolean) => appSettings.set('pianoRollAutoReharmonize', value),
  });

  /** Drum classification must see sibling clips, even when the active clip is empty. */
  const activeTrackNotes = computed(() => {
    const track = store.activeTrack;
    return track
      ? (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes)
      : store.notes;
  });

  const reharmonizeActive = computed(
    () =>
      autoReharmonize.value &&
      store.activeTrack !== null &&
      !isDrumTrack(store.activeTrack, activeTrackNotes.value) &&
      store.activeTrack?.frozen === undefined &&
      store.clipId >= 0 &&
      (store.activeClip?.kind ?? 'midi') === 'midi' &&
      store.chords.length > 0,
  );

  const pendingProposal = ref<ProjectReharmonizationProposal | null>(null);
  const lockedRegions = ref<LockedRegion[]>([]);

  // Settled-state snapshot of the active clip's notes; spans are diffed
  // against it, so it tracks the clip the snapshot was taken from.
  let snapshot: HarmonicNoteSnapshot[] = snapshotNotes(store.notes);
  let snapshotClipId = store.clipId;

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSettleTimer(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  }

  function dismissPendingProposal(): void {
    pendingProposal.value = null;
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    dismissTimer = null;
  }

  /** Re-baselines the snapshot to the current notes without proposing. */
  function resyncSnapshot(): void {
    snapshot = snapshotNotes(store.notes);
    snapshotClipId = store.clipId;
  }

  /** Runs when an edit settles: diff, re-baseline, then propose. */
  function onEditSettled(): void {
    settleTimer = null;
    if (store.clipId !== snapshotClipId) {
      resyncSnapshot();
      return;
    }
    const span = changedNotesSpan(snapshot, store.notes);
    resyncSnapshot();
    if (span === null || !reharmonizeActive.value) return;
    const clip = store.activeClip;
    if (clip === null) return;
    // A looping clip repeats the edited source region at every occurrence on the
    // timeline; reharmonize all of them, not just the first window, so later
    // repetitions do not keep stale chords.
    const clipEnd = clip.startPpq + clip.lengthPpq;
    const window = audibleMidiSourceWindow(clip);
    const looping =
      clip.loopEnabled === true && (clip.loopLengthPpq ?? 0) > 0 && window.lengthPpq > 0;
    const occurrences = looping
      ? Math.min(Math.ceil(clip.lengthPpq / window.lengthPpq), MAX_LOOP_OCCURRENCES)
      : 1;
    const editedSpans: { startPpq: number; endPpq: number }[] = [];
    for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
      const repeatOffset = occurrence * window.lengthPpq;
      const startPpq = Math.max(
        clip.startPpq,
        midiSourcePpqToTimeline(clip, span.startPpq) + repeatOffset,
      );
      const endPpq = Math.min(clipEnd, midiSourcePpqToTimeline(clip, span.endPpq) + repeatOffset);
      if (endPpq > startPpq) editedSpans.push({ startPpq, endPpq });
    }
    if (editedSpans.length === 0) return;
    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: editedSpans,
      locked: [...lockedRegions.value],
    });
    if (proposal === null || !proposal.changed) return;
    pendingProposal.value = proposal;
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => dismissPendingProposal(), REHARMONIZE_AUTO_DISMISS_MS);
  }

  // Note edits drive the session: a change supersedes any pending suggestion
  // immediately and restarts the settle debounce. While suggestions are
  // inactive the snapshot just follows along, so enabling the preference later
  // never diffs against a stale baseline.
  watch(
    () => store.notes,
    () => {
      clearSettleTimer();
      dismissPendingProposal();
      if (!reharmonizeActive.value || store.clipId !== snapshotClipId) {
        resyncSnapshot();
        return;
      }
      settleTimer = setTimeout(onEditSettled, REHARMONIZE_SETTLE_MS);
    },
  );

  // Switching clips re-baselines; a suggestion for another clip's edit is moot.
  watch(
    () => store.clipId,
    () => {
      clearSettleTimer();
      dismissPendingProposal();
      resyncSnapshot();
    },
  );

  // A loaded/initialized project can reuse the same editor clip id. Session
  // locks and proposals belong to the old document nevertheless, so the
  // store's monotonic document generation is the lifecycle boundary.
  watch(
    () => store.documentGeneration,
    () => {
      clearSettleTimer();
      dismissPendingProposal();
      lockedRegions.value = [];
      resyncSnapshot();
    },
  );

  // Any chord-track change invalidates a pending proposal computed against the
  // old track (applying our own proposal clears pending first, so this only
  // catches external edits).
  watch(
    () => store.chords,
    () => dismissPendingProposal(),
  );

  // Key/meter changes alter candidate ranking and strong-beat weighting.
  watch([() => store.scaleHighlight, () => store.timeSignatures], () => dismissPendingProposal(), {
    deep: true,
  });

  // Turning the preference off drops any in-flight suggestion.
  watch(autoReharmonize, (enabled) => {
    if (!enabled) {
      clearSettleTimer();
      dismissPendingProposal();
    }
  });

  const pendingChanges = computed<PendingChordChange[]>(() => {
    const proposal = pendingProposal.value;
    if (proposal === null || !proposal.changed) return [];
    const current = [...store.chords].sort(
      (a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq,
    );
    return proposal.changedIndices.flatMap((index) => {
      const from = current[index];
      const to = proposal.proposal[index];
      return from !== undefined && to !== undefined
        ? [
            {
              index,
              from: formatChordName(
                from,
                keyFifthsForScaleHighlight(store.scaleHighlight),
                noteNames.system.value,
              ),
              to: formatChordName(
                to,
                keyFifthsForScaleHighlight(store.scaleHighlight),
                noteNames.system.value,
              ),
            },
          ]
        : [];
    });
  });

  function applyPendingProposal(): void {
    const proposal = pendingProposal.value;
    if (proposal === null) return;
    dismissPendingProposal();
    applyReharmonizationProposal(proposal, lockedRegions.value);
  }

  function toggleLock(region: LockedRegion): void {
    dismissPendingProposal();
    lockedRegions.value = toggleLockRegion(lockedRegions.value, region);
  }

  function isLocked(region: LockedRegion): boolean {
    return isRegionLocked(lockedRegions.value, region);
  }

  onScopeDispose(() => {
    clearSettleTimer();
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    dismissTimer = null;
  });

  return {
    autoReharmonize,
    reharmonizeActive,
    pendingProposal,
    pendingChanges,
    applyPendingProposal,
    dismissPendingProposal,
    lockedRegions,
    toggleLock,
    isLocked,
  };
}

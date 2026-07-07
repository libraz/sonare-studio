/**
 * Composition guidance for the piano-roll editor: derives the note grid's
 * background safety tint and the per-note hover theory card from the project
 * store's active clip, chord track, key and meter.
 *
 * Everything hangs off one `computed` guidance pass, so the (comparatively
 * expensive) theory analysis reruns only when its store inputs change — never
 * per animation frame.
 */

import { chordToRoman, functionOf } from '@libraz/libcantus';
import { type ComputedRef, computed } from 'vue';
import { buildChordTimeline } from '@/compose/chord-at-tick';
import { buildTheoryCard, type TheoryCard } from '@/compose/explain';
import { buildGuidance, type GuidanceResult, type GuidanceSegment } from '@/compose/guidance';
import { effectiveKeyScale } from '@/compose/key';
import type { TrackWithNotes } from '@/compose/tracks';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

export interface PianoRollGuidance {
  /** Background tint segments for the note grid; undefined without an active clip. */
  guidanceSegments: ComputedRef<GuidanceSegment[] | undefined>;
  /** Hover theory-card resolver for the note grid; undefined without an active clip. */
  noteCard: ComputedRef<((noteId: number) => TheoryCard | null) | undefined>;
}

/** Builds the reactive composition-guidance surface for the active clip. */
export function usePianoRollGuidance(): PianoRollGuidance {
  const store = useProjectStore();
  const { t } = useI18n();

  const guidance = computed<GuidanceResult | null>(() => {
    const clip = store.activeClip;
    if (!clip) return null;
    // Voice context: every non-active track, its notes flattened across the
    // track's clips and shifted to absolute timeline PPQ (guidance drops
    // percussion tracks itself).
    const otherTracks: TrackWithNotes[] = [];
    for (const track of store.tracks) {
      if (track.id === clip.trackId) continue;
      const clips = store.clipsByTrack.get(track.id) ?? [];
      const notes = clips.flatMap((other) =>
        other.notes.map((note) => ({ ...note, startPpq: note.startPpq + other.startPpq })),
      );
      otherTracks.push({ track, notes });
    }
    return buildGuidance({
      notes: clip.notes,
      clipStartPpq: clip.startPpq,
      chordSymbols: store.chords,
      key: store.scaleHighlight,
      timeSignatures: store.timeSignatures,
      otherTracks,
    });
  });

  /** Chord timeline for card context, built once per chord-track change. */
  const chordTimeline = computed(() => buildChordTimeline(store.chords));

  /** Resolves the hover theory card for one active-clip note, or null. */
  function theoryCardFor(noteId: number): TheoryCard | null {
    const result = guidance.value;
    const clip = store.activeClip;
    if (result === null || clip === null) return null;
    const analysis = result.byNoteId.get(noteId);
    if (analysis === undefined) return null;
    const note = clip.notes.find((candidate) => candidate.id === noteId);
    if (note === undefined) return null;
    const ctx: Parameters<typeof buildTheoryCard>[1] = {
      pitch: note.pitch,
      keySet: result.keySet,
    };
    const chord = chordTimeline.value.at(clip.startPpq + note.startPpq);
    if (chord !== null) {
      const key = effectiveKeyScale(store.scaleHighlight);
      try {
        ctx.chordRoman = chordToRoman(chord, key);
        ctx.chordFunction = functionOf(chord, key);
      } catch {
        // Unmappable chord: the card simply omits the chord line.
      }
    }
    return buildTheoryCard(analysis, ctx, t.value.theory);
  }

  const guidanceSegments = computed(() => guidance.value?.segments);
  const noteCard = computed(() => (guidance.value !== null ? theoryCardFor : undefined));

  return { guidanceSegments, noteCard };
}

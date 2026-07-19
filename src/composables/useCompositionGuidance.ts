/**
 * Composition guidance shared by the note-editing surfaces (piano roll and
 * score): derives the note grid's background safety tint, the per-note hover
 * theory card, and voice-leading resolution arrows from the project store's
 * active clip, chord track, key and meter.
 *
 * Everything hangs off one `computed` guidance pass, so the (comparatively
 * expensive) theory analysis reruns only when its store inputs change — never
 * per animation frame. The surface is DOM-free, so any editor showing the
 * active clip's notes can consume it (the score reuses the card resolver).
 */

import { chordToRoman, functionOf } from '@libraz/libcantus';
import { type ComputedRef, computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { buildChordTimeline } from '@/compose/chord-at-tick';
import {
  buildTheoryCard,
  type TheoryCard,
  type TheoryLabels,
  theoryLabelsFor,
} from '@/compose/explain';
import {
  buildGuidance,
  type GuidanceResult,
  type GuidanceSegment,
  resolutionTargetOf,
} from '@/compose/guidance';
import { effectiveKeyScale } from '@/compose/key';
import type { TrackWithNotes } from '@/compose/tracks';
import {
  audibleMidiProjector,
  projectMidiClipNoteOccurrences,
  projectMidiNoteOccurrences,
} from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/** A voice-leading resolution to draw as an arrow on the note grid. */
export interface ResolutionArrow {
  /** Editor id of the note that must resolve. */
  noteId: number;
  /** Clip-relative beat of the note's right edge (arrow origin). */
  endBeat: number;
  /** MIDI pitch of the resolving note (arrow origin row). */
  fromPitch: number;
  /** MIDI pitch the note resolves to (arrow target row). */
  toPitch: number;
}

export interface CompositionGuidance {
  /** Background tint segments for the note grid; undefined without an active clip. */
  guidanceSegments: ComputedRef<GuidanceSegment[] | undefined>;
  /** Hover theory-card resolver for the note grid; undefined without an active clip. */
  noteCard: ComputedRef<((noteId: number) => TheoryCard | null) | undefined>;
  /** Resolution arrows for the active clip's notes; undefined without an active clip. */
  resolutionArrows: ComputedRef<ResolutionArrow[] | undefined>;
}

/** Builds the reactive composition-guidance surface for the active clip. */
export function useCompositionGuidance(): CompositionGuidance {
  const store = useProjectStore();
  const { t } = useI18n();
  const appSettings = useAppSettings();

  /**
   * Card string bundle for the active explanation level: the shared role /
   * function / line labels plus the selected level's wording and the glossary.
   * Recomputes when the language or the level preference changes.
   */
  const cardLabels = computed<TheoryLabels>(() =>
    theoryLabelsFor(t.value.theory, appSettings.settings.explainLevel),
  );

  const guidance = computed<GuidanceResult | null>(() => {
    const clip = store.activeClip;
    if (!clip) return null;
    const activeNotes = projectMidiClipNoteOccurrences(clip, { expandLoops: false });
    // Voice context: every non-active track, its notes flattened across the
    // track's clips and shifted to absolute timeline PPQ (guidance drops
    // percussion tracks itself).
    const otherTracks: TrackWithNotes[] = [];
    for (const track of store.tracks) {
      if (track.id === clip.trackId) continue;
      const clips = store.clipsByTrack.get(track.id) ?? [];
      let syntheticId = -1;
      const notes = clips.flatMap((other) =>
        projectMidiNoteOccurrences(other).map((note) => ({ ...note, id: syntheticId-- })),
      );
      otherTracks.push({ track, notes });
    }
    return buildGuidance({
      notes: activeNotes,
      clipStartPpq: clip.startPpq,
      clipLengthPpq: clip.lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq,
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
    const occurrence = audibleMidiProjector(clip, { expandLoops: false }).find(
      (entry) => entry.sourceIdentity.noteId === noteId,
    );
    if (!occurrence) return null;
    const ctx: Parameters<typeof buildTheoryCard>[1] = {
      pitch: note.pitch,
      velocity: note.velocity,
      keySet: result.keySet,
    };
    const chord = chordTimeline.value.at(occurrence.timelineStartPpq);
    if (chord !== null) {
      const key = effectiveKeyScale(store.scaleHighlight);
      try {
        ctx.chordRoman = chordToRoman(chord, key);
        ctx.chordFunction = functionOf(chord, key);
      } catch {
        // Unmappable chord: the card simply omits the chord line.
      }
    }
    return buildTheoryCard(analysis, ctx, cardLabels.value);
  }

  // buildGuidance already emits segments in the clip's source frame (see its
  // sourceOffsetPpq input), matching the notes the piano roll draws.
  const guidanceSegments = computed(() => guidance.value?.segments);
  // Re-emit the resolver identity when the level changes too, so consumers that
  // key off `noteCard` re-render the currently shown card at the new level.
  const noteCard = computed(() =>
    guidance.value !== null && cardLabels.value ? theoryCardFor : undefined,
  );

  /** Resolution arrows for notes carrying a resolution obligation. */
  const resolutionArrows = computed<ResolutionArrow[] | undefined>(() => {
    const result = guidance.value;
    const clip = store.activeClip;
    if (result === null || clip === null) return undefined;
    const arrows: ResolutionArrow[] = [];
    // Arrow origins are the notes' right edges in the same source-relative frame
    // the piano roll draws in, so add the clip's trim offset to the projector's
    // window-relative positions (see guidanceSegments).
    const sourceOffsetPpq = clip.sourceOffsetPpq ?? 0;
    for (const occurrence of audibleMidiProjector(clip, { expandLoops: false })) {
      const note = occurrence.note;
      const analysis = result.byNoteId.get(note.id);
      if (analysis === undefined) continue;
      const toPitch = resolutionTargetOf(analysis);
      if (toPitch === undefined) continue;
      arrows.push({
        noteId: note.id,
        endBeat: occurrence.clipStartPpq + sourceOffsetPpq + occurrence.durationPpq,
        fromPitch: note.pitch,
        toPitch,
      });
    }
    return arrows;
  });

  return { guidanceSegments, noteCard, resolutionArrows };
}

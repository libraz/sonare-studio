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

import { chordToRoman, functionOf, NoteSafety } from '@libraz/libcantus';
import { type ComputedRef, computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useNoteNames } from '@/composables/useNoteNames';
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
import { analyzeHarmony } from '@/compose/harmonic-analysis';
import { DEFAULT_KEY_SCALE } from '@/compose/key';
import { buildKeyMap } from '@/compose/key-map';
import { isDrumTrack } from '@/compose/tracks';
import { buildVoiceLines } from '@/compose/voice-context';
import { audibleMidiProjector } from '@/project/midi-projection';
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
  /**
   * Background tint segments for the note grid; undefined without an active
   * clip or while the background-tint setting is off.
   */
  guidanceSegments: ComputedRef<GuidanceSegment[] | undefined>;
  /** Hover theory-card resolver for the note grid; undefined without an active clip. */
  noteCard: ComputedRef<((noteId: number) => TheoryCard | null) | undefined>;
  /** Harmonic warning severity per active-clip note; notes with no harmonic clash are omitted. */
  noteSafety: ComputedRef<ReadonlyMap<number, NoteSafety.Warning | NoteSafety.Dissonant>>;
  /** Resolution arrows for the active clip's notes; undefined without an active clip. */
  resolutionArrows: ComputedRef<ResolutionArrow[] | undefined>;
  /** Active-clip notes whose expected resolution did not follow. */
  unresolvedNoteIds: ComputedRef<ReadonlySet<number>>;
}

export interface CompositionGuidanceOptions {
  /** Reactive getter used by hidden editor surfaces to skip expensive analysis. */
  enabled?: () => boolean;
}

/** Builds the reactive composition-guidance surface for the active clip. */
export function useCompositionGuidance(
  options: CompositionGuidanceOptions = {},
): CompositionGuidance {
  const store = useProjectStore();
  const { t } = useI18n();
  const appSettings = useAppSettings();
  const noteNames = useNoteNames();
  const isEnabled = options.enabled ?? (() => true);

  /**
   * Card string bundle for the active explanation level: the shared role /
   * function / line labels plus the selected level's wording and the glossary.
   * The cadence names come from the harmony block the chord lane writes with,
   * so both surfaces name a cadence the same way.
   * Recomputes when the language or the level preference changes.
   */
  const cardLabels = computed<TheoryLabels>(() =>
    theoryLabelsFor(t.value.theory, appSettings.settings.explainLevel, t.value.harmony.cadence),
  );

  /** Source-window occurrences used by editor cards and resolution arrows. */
  const activeOccurrences = computed(() => {
    const clip = store.activeClip;
    return clip ? audibleMidiProjector(clip, { expandLoops: false }) : [];
  });

  /** Every audible loop occurrence used by harmonic guidance aggregation. */
  const guidanceOccurrences = computed(() => {
    const clip = store.activeClip;
    return clip ? audibleMidiProjector(clip) : [];
  });

  const activeNotes = computed(() =>
    guidanceOccurrences.value.map((entry) => ({
      ...entry.note,
      startPpq: entry.clipStartPpq,
      durationPpq: entry.durationPpq,
    })),
  );

  /** The active track and all of its notes, used for durable drum detection. */
  const activeTrack = computed(() => {
    const clip = store.activeClip;
    return clip ? (store.tracks.find((entry) => entry.id === clip.trackId) ?? null) : null;
  });
  const activeTrackNotes = computed(() => {
    const track = activeTrack.value;
    return track ? (store.clipsByTrack.get(track.id) ?? []).flatMap((entry) => entry.notes) : [];
  });
  const activeTrackIsDrum = computed(() => {
    const track = activeTrack.value;
    return track !== null && isDrumTrack(track, activeTrackNotes.value);
  });

  const activeOccurrenceByNoteId = computed(
    () => new Map(activeOccurrences.value.map((entry) => [entry.note.id, entry])),
  );

  /** The project's key timeline: the declared key overridden by `Key:` markers. */
  const keyMap = computed(() => buildKeyMap(store.scaleHighlight, store.markers));

  const guidance = computed<GuidanceResult | null>(() => {
    if (!isEnabled()) return null;
    const clip = store.activeClip;
    if (!clip) return null;
    const track = activeTrack.value;
    // Percussion has no harmonic guidance surface. Avoid constructing chord,
    // voice-leading and sustained-boundary analysis for a track whose consumers
    // will suppress every result; this also keeps a dense drum clip cheap while
    // editing it.
    if (activeTrackIsDrum.value) {
      return { segments: [], byNoteId: new Map(), keySet: false, chordPresent: false };
    }
    const followers = store.tracks.filter(
      (entry) => entry.leadFollow?.leadTrackId === clip.trackId,
    );
    // Each follower's parked notes, as clips of that track holding only them.
    const parkedClips = new Map(
      followers.map((follower) => [
        follower.id,
        (store.clipsByTrack.get(follower.id) ?? []).flatMap((entry) => {
          const parked = (follower.leadFollow?.stash ?? []).filter((s) => s.clipId === entry.id);
          return parked.length > 0
            ? [{ ...entry, notes: parked.map((s, index) => ({ ...s.note, id: -1 - index })) }]
            : [];
        }),
      ]),
    );
    return buildGuidance({
      notes: activeNotes.value,
      clipStartPpq: clip.startPpq,
      clipLengthPpq: clip.lengthPpq,
      sourceOffsetPpq: clip.sourceOffsetPpq,
      chordSymbols: store.chords,
      key: store.scaleHighlight,
      keyMap: keyMap.value,
      timeSignatures: store.timeSignatures,
      profile: appSettings.settings.guidanceProfile,
      ...(track !== null ? { track } : {}),
      // Every other track, loops expanded, as it actually sounds.
      lines: buildVoiceLines(store.tracks, store.clipsByTrack, clip.trackId),
      parkedLines: buildVoiceLines(followers, parkedClips, clip.trackId),
      followerTrackIds: new Set(followers.map((follower) => follower.id)),
    });
  });

  /** Chord timeline for card context, built once per chord-track change. */
  const chordTimeline = computed(() => buildChordTimeline(store.chords));
  /** Functional chord labels shared with the chord lane, including V7/x. */
  const harmonicAnalysis = computed(() => analyzeHarmony(store.chords, keyMap.value));

  /** Resolves the hover theory card for one active-clip note, or null. */
  function theoryCardFor(noteId: number): TheoryCard | null {
    const result = guidance.value;
    const clip = store.activeClip;
    if (result === null || clip === null) return null;
    const analysis = result.byNoteId.get(noteId);
    if (analysis === undefined) return null;
    const occurrence = activeOccurrenceByNoteId.value.get(noteId);
    if (!occurrence) return null;
    const at = occurrence.timelineStartPpq;
    const keySet = keyMap.value.keySetAt(at);
    const ctx: Parameters<typeof buildTheoryCard>[1] = {
      pitch: occurrence.note.pitch,
      velocity: occurrence.note.velocity,
      keySet,
      keyEstimated: store.scaleHighlightEstimated,
      noteNameSystem: noteNames.system.value,
      trackName: (trackId) => store.tracks.find((track) => track.id === trackId)?.name,
      ...(keySet ? { keyFifths: keyMap.value.keyFifthsAt(at) } : {}),
    };
    const chord = chordTimeline.value.at(at);
    if (chord !== null) {
      const key = keyMap.value.at(at) ?? DEFAULT_KEY_SCALE;
      try {
        const symbol = store.chords.find((entry) => at >= entry.startPpq && at < entry.endPpq);
        const appliedRoman =
          symbol === undefined
            ? undefined
            : harmonicAnalysis.value.byStartPpq.get(symbol.startPpq)?.appliedRoman;
        ctx.chordRoman = appliedRoman ?? chordToRoman(chord, key);
        ctx.chordFunction = functionOf(chord, key);
      } catch {
        // Unmappable chord: the card simply omits the chord line.
      }
    }
    return buildTheoryCard(analysis, ctx, cardLabels.value);
  }

  // buildGuidance already emits segments in the clip's source frame (see its
  // sourceOffsetPpq input), matching the notes the piano roll draws.
  const guidanceSegments = computed(() => {
    const result = guidance.value;
    if (
      !appSettings.settings.pianoRollGuidanceTint ||
      result === null ||
      !result.chordPresent ||
      activeTrackIsDrum.value
    ) {
      return undefined;
    }
    return result.segments;
  });
  // Re-emit the resolver identity when the level changes too, so consumers that
  // key off `noteCard` re-render the currently shown card at the new level.
  const noteCard = computed(() =>
    guidance.value !== null && cardLabels.value && !activeTrackIsDrum.value
      ? (noteId: number) => theoryCardFor(noteId)
      : undefined,
  );

  const noteSafety = computed<ReadonlyMap<number, NoteSafety.Warning | NoteSafety.Dissonant>>(
    () => {
      const result = guidance.value;
      if (result === null || activeTrackIsDrum.value) return new Map();
      const out = new Map<number, NoteSafety.Warning | NoteSafety.Dissonant>();
      for (const [noteId, analysis] of result.byNoteId) {
        let worst: NoteSafety.Warning | NoteSafety.Dissonant | undefined = analysis.worstSafety;
        if (analysis.chordSounding) {
          const onset = analysis.safety?.safety;
          if (
            (onset === NoteSafety.Warning || onset === NoteSafety.Dissonant) &&
            (worst === undefined || onset > worst)
          ) {
            worst = onset;
          }
        }
        const sustained = analysis.sustainedSafety?.safety;
        if (
          (sustained === NoteSafety.Warning || sustained === NoteSafety.Dissonant) &&
          (worst === undefined || sustained > worst)
        ) {
          worst = sustained;
        }
        if (worst !== undefined) out.set(noteId, worst);
      }
      return out;
    },
  );

  /** Resolution arrows for notes carrying a resolution obligation. */
  const resolutionArrows = computed<ResolutionArrow[] | undefined>(() => {
    const result = guidance.value;
    const clip = store.activeClip;
    if (result === null || clip === null || activeTrackIsDrum.value) return undefined;
    const arrows: ResolutionArrow[] = [];
    // Arrow origins are the notes' right edges in the same source-relative frame
    // the piano roll draws in, so add the clip's trim offset to the projector's
    // window-relative positions (see guidanceSegments).
    const sourceOffsetPpq = clip.sourceOffsetPpq ?? 0;
    for (const occurrence of activeOccurrences.value) {
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

  const unresolvedNoteIds = computed<ReadonlySet<number>>(() => {
    if (activeTrackIsDrum.value) return new Set<number>();
    const ids = new Set<number>();
    for (const [id, analysis] of guidance.value?.byNoteId ?? []) {
      if (analysis.pendingResolution?.resolved === false) ids.add(id);
    }
    return ids;
  });

  return { guidanceSegments, noteCard, noteSafety, resolutionArrows, unresolvedNoteIds };
}

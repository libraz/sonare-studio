/**
 * Annotate tool of the score panel: the floating palette's target note, the
 * armed slur/hairpin/line-span state, and the edits the palette applies.
 */

import { computed, type Ref, ref, watch } from 'vue';
import type { NoteHairpin, NoteLineSpan, ScoreNoteAnnotation } from '@/project/annotations';
import {
  clearNoteAnnotation,
  type NoteAnnotationUpdate,
  setNoteAnnotation,
} from '@/project/commands';
import type { useProjectStore } from '@/project/store';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Configuration for {@link useScoreAnnotations}. */
export interface UseScoreAnnotationsOptions {
  /** The project store (active clip, notes and annotations). */
  store: ProjectStore;
  /** Score body element whose parent wrapper the palette position is relative to. */
  svgHost: Ref<HTMLDivElement | null>;
  /** Runs a score edit, surfacing a thrown error; true when it succeeded. */
  tryScoreEdit: (edit: () => void) => boolean;
  /** Re-engraves the score. */
  transcribe: () => Promise<void>;
}

/**
 * Creates the annotate-tool state of one score panel.
 *
 * @param options - The store, score body element and edit helpers.
 * @returns The palette state, the annotate click/drag hooks and the palette edits.
 */
export function useScoreAnnotations(options: UseScoreAnnotationsOptions) {
  const { store, svgHost, tryScoreEdit, transcribe } = options;

  /** True while the Annotate tool is active (note clicks open the palette). */
  const annotateEnabled = ref(false);
  /** Editor note id the floating palette currently edits (null = closed). */
  const annotationNoteId = ref<number | null>(null);
  /** Clip half of the palette's composite note identity. */
  const annotationClipId = ref<number | null>(null);
  /** Palette position relative to the score body wrapper, in pixels. */
  const palettePos = ref({ x: 0, y: 0 });
  /** True while waiting for the slur target click ("slur to next selected"). */
  const slurArmed = ref(false);
  /** Hairpin type waiting for a target click, or null when not armed. */
  const hairpinArmed = ref<NoteHairpin | null>(null);
  /** Line/span type waiting for a target click, or null when not armed. */
  const lineSpanArmed = ref<NoteLineSpan | null>(null);

  /** Current annotation of the palette's target note (empty when none). */
  const annotationCurrent = computed<ScoreNoteAnnotation>(() => {
    const id = annotationNoteId.value;
    const clipId = annotationClipId.value;
    if (id === null || clipId === null) return {};
    return store.scoreAnnotations[clipId]?.[id] ?? {};
  });

  /** Clears every armed slur, hairpin and line/span target. */
  function disarmTargets(): void {
    slurArmed.value = false;
    hairpinArmed.value = null;
    lineSpanArmed.value = null;
  }

  /** Opens the palette on a note of a clip without a pointer, switching Annotate on. */
  function openPalette(noteId: number, clipId: number): void {
    annotateEnabled.value = true;
    disarmTargets();
    annotationNoteId.value = noteId;
    annotationClipId.value = clipId;
    palettePos.value = { x: 24, y: 48 };
  }

  /** Arms or disarms the slur target click; arming disarms the other targets. */
  function armSlur(armed: boolean): void {
    slurArmed.value = armed;
    if (armed) {
      hairpinArmed.value = null;
      lineSpanArmed.value = null;
    }
  }

  /** Arms a hairpin target click (null disarms); arming disarms the other targets. */
  function armHairpin(hairpin: NoteHairpin | null): void {
    hairpinArmed.value = hairpin;
    if (hairpin !== null) {
      slurArmed.value = false;
      lineSpanArmed.value = null;
    }
  }

  /** Arms a line/span target click (null disarms); arming disarms the other targets. */
  function armLineSpan(lineSpan: NoteLineSpan | null): void {
    lineSpanArmed.value = lineSpan;
    if (lineSpan !== null) {
      slurArmed.value = false;
      hairpinArmed.value = null;
    }
  }

  /**
   * Annotate-mode note click: completes an armed slur/hairpin (click A, arm,
   * click B), otherwise retargets the floating palette at the clicked note.
   */
  function onAnnotateClick(event: MouseEvent, ids: number[]): void {
    const clicked = ids[0];
    if (clicked === undefined) {
      closePalette();
      return;
    }
    const clickedClipId = store.clipId;
    // A second click on another note of the palette's clip completes an armed target.
    const completesTarget =
      annotationClipId.value === clickedClipId &&
      annotationNoteId.value !== null &&
      clicked !== annotationNoteId.value;
    if (completesTarget && slurArmed.value) {
      slurArmed.value = false;
      applyAnnotation({ slurToNoteId: clicked });
      return;
    }
    if (completesTarget && hairpinArmed.value !== null) {
      const hairpin = hairpinArmed.value;
      hairpinArmed.value = null;
      applyAnnotation({ hairpin, hairpinToNoteId: clicked });
      return;
    }
    if (completesTarget && lineSpanArmed.value !== null) {
      const lineSpan = lineSpanArmed.value;
      lineSpanArmed.value = null;
      applyAnnotation({ addLineSpan: { lineSpan, lineSpanToNoteId: clicked } });
      return;
    }
    disarmTargets();
    annotationNoteId.value = clicked;
    annotationClipId.value = clickedClipId;
    const wrap = svgHost.value?.parentElement;
    const rect = wrap?.getBoundingClientRect();
    palettePos.value = {
      x: event.clientX - (rect?.left ?? 0) + 8,
      y: event.clientY - (rect?.top ?? 0) + 8,
    };
  }

  /** Annotate-mode vertical drag: force the clicked note onto the upper/lower staff. */
  function onAnnotateStaffDrag(ids: number[], staff: 1 | 2): void {
    const id = ids[0];
    if (id === undefined) return;
    if (tryScoreEdit(() => setNoteAnnotation(store.clipId, id, { staffOverride: staff }))) {
      closePalette();
      void transcribe();
    }
  }

  /** Applies a field-wise annotation edit to the palette's target note. */
  function applyAnnotation(update: NoteAnnotationUpdate): void {
    const id = annotationNoteId.value;
    const clipId = annotationClipId.value;
    if (id === null || clipId === null) return;
    tryScoreEdit(() => setNoteAnnotation(clipId, id, update));
  }

  /** Removes every annotation of the target note. */
  function clearAnnotation(): void {
    const id = annotationNoteId.value;
    const clipId = annotationClipId.value;
    if (id === null || clipId === null) return;
    tryScoreEdit(() => clearNoteAnnotation(clipId, id));
  }

  /** Closes the floating palette and disarms any pending slur. */
  function closePalette(): void {
    annotationNoteId.value = null;
    annotationClipId.value = null;
    disarmTargets();
  }

  watch(annotateEnabled, (enabled) => {
    if (!enabled) closePalette();
  });
  // The palette targets a note of the active clip; close it when its note
  // disappears (deleted or replaced by other edits). Clip switches are handled by
  // the panel's immediate transcribe watcher.
  watch(
    () => store.notes,
    (notes) => {
      const id = annotationNoteId.value;
      if (id !== null && !notes.some((note) => note.id === id)) closePalette();
    },
  );

  return {
    annotateEnabled,
    annotationNoteId,
    annotationClipId,
    palettePos,
    slurArmed,
    hairpinArmed,
    lineSpanArmed,
    annotationCurrent,
    openPalette,
    armSlur,
    armHairpin,
    armLineSpan,
    onAnnotateClick,
    onAnnotateStaffDrag,
    applyAnnotation,
    clearAnnotation,
    closePalette,
  };
}

<script setup lang="ts">
import type { NoteSafety } from '@libraz/libcantus';
import { ref } from 'vue';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';
import TheoryCardView from '@/components/compose/TheoryCardView.vue';
import type { ResolutionArrow } from '@/composables/useCompositionGuidance';
import type { PlacementColumn } from '@/composables/usePlacementGuidance';
import type { TheoryCard } from '@/compose/explain';
import type { GuidanceSegment } from '@/compose/guidance';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';
import { useI18n } from '@/ui/i18n';
import { useNoteGridAccessibility } from '@/ui/piano-roll/use-note-grid-accessibility';
import { useNoteGridPainter } from '@/ui/piano-roll/use-note-grid-painter';
import { useNoteGridPointer } from '@/ui/piano-roll/use-note-grid-pointer';
import { useNoteGridTheoryCard } from '@/ui/piano-roll/use-note-grid-theory-card';
import type { InteractionPoint, NoteInteractions } from '@/ui/piano-roll/use-note-interactions';
import type { GhostNote } from './overlay';
import type { NoteColorFn } from './theme';

/**
 * Scrollable/zoomable note grid canvas of the piano roll: pitch rows, beat and
 * bar gridlines, note rectangles, marquee and playhead overlay. Rendering is
 * split into background (rows/grid), note and overlay layers so common updates
 * repaint the smallest useful surface.
 */

const props = defineProps<{
  /** Shared timeline viewport (this component owns its resize). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Notes to render (store mirror; a gesture preview overrides it). */
  notes: EditorNote[];
  /** Selected note ids. */
  selection: Set<number>;
  /** Scale-highlight flags per pitch class (index 0 = C). */
  highlightedPitchClasses: boolean[];
  /** Snap grid step in PPQ (fine gridline spacing). */
  gridPpq: number;
  /** Length of the edited clip in PPQ; the region past it is shaded. */
  clipLengthPpq: number;
  /** Left boundary of the editable source window in PPQ. */
  minPpq?: number;
  /** Project time signatures for bar/beat gridlines. */
  timeSignatures: TimeSignatureSegment[];
  /** Arrangement PPQ corresponding to local clip-source PPQ 0. */
  timeSignatureOriginPpq?: number;
  /** Gesture state machine shared with the container. */
  interactions: NoteInteractions;
  /** The active tool; ghost notes only switch clips while selecting. */
  activeTool?: EditorToolId;
  /** Playhead position getter in PPQ; omit to hide the playhead. */
  positionPpq?: () => number;
  /** Fixed local column to pin the playhead to while following, else null. */
  anchoredLocalX?: () => number | null;
  /** Per-note color resolver (single track color by default). */
  noteColor?: NoteColorFn;
  /** Read-only ghost notes from non-active clips, drawn under the notes. */
  ghostNotes?: GhostNote[];
  /** Guidance tint segments in clip-relative beats; omit to draw no tint. */
  guidanceSegments?: GuidanceSegment[];
  /** Hover theory-card resolver per note id; omit to disable the card. */
  noteCard?: (noteId: number) => TheoryCard | null;
  /** Voice-leading resolution arrows for the active clip; omit to draw none. */
  resolutionArrows?: ResolutionArrow[];
  /** Chord-context warning severity per note; no-chord notes are omitted. */
  noteSafety?: ReadonlyMap<number, NoteSafety.Warning | NoteSafety.Dissonant>;
  /** Pencil placement verdicts (indexed by MIDI pitch) for one cell; null or omitted draws none. */
  placementColumn?: PlacementColumn | null;
  /** Notes whose expected resolution did not follow; they carry the warning band. */
  unresolvedNoteIds?: ReadonlySet<number>;
}>();

const { t } = useI18n();

const emit = defineEmits<{
  /** Fired after the grid viewport was resized and the range re-clamped. */
  'view-resize': [widthPx: number, heightPx: number];
  /** Fired when a pointer press lands on a ghost note (read-only overlay). */
  'ghost-activate': [ghost: GhostNote];
  /** Right-click on the grid: noteId is null when no note was hit. */
  'note-context': [payload: { x: number; y: number; noteId: number | null; ppq: number }];
  /** Hovered musical position for status readouts. */
  'hover-status': [payload: { ppq: number; pitch: number } | null];
  /** Accessible virtual-object edit routed to the owning command surface. */
  'note-keyboard-action': [
    payload:
      | { noteId: number; kind: 'select' }
      | { noteId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
      | { noteId: number; kind: 'set'; controlId: string; value: number },
  ];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const backgroundCanvas = ref<HTMLCanvasElement | null>(null);
const notesCanvas = ref<HTMLCanvasElement | null>(null);
const overlayCanvas = ref<HTMLCanvasElement | null>(null);
const hoveredGhost = ref<GhostNote | null>(null);
/** Editable note under the pointer during a passive hover (no drag in flight). */
const hoveredNote = ref<EditorNote | null>(null);
const hoverPoint = ref<InteractionPoint | null>(null);

const { hoveredCard, cardHold, updateTheoryCard, theoryCardStyle } = useNoteGridTheoryCard({
  props,
  wrapper,
  hoveredGhost,
  hoveredNote,
});

const {
  liveStatus,
  accessibleNotes,
  onAccessibleNoteActivate,
  onAccessibleNoteContext,
  onAccessibleNoteAdjust,
  onAccessibleNoteValue,
} = useNoteGridAccessibility({ props, emit, wrapper });

const { scheduleOverlay } = useNoteGridPainter({
  props,
  emit,
  wrapper,
  backgroundCanvas,
  notesCanvas,
  overlayCanvas,
  hoveredGhost,
  hoveredNote,
  hoverPoint,
  hoveredCard,
});

const {
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onDoubleClick,
  onContextMenu,
} = useNoteGridPointer({
  props,
  emit,
  wrapper,
  hoveredGhost,
  hoveredNote,
  hoverPoint,
  cardHold,
  updateTheoryCard,
  scheduleOverlay,
});
</script>

<template>
  <div
    ref="wrapper"
    class="note-grid"
    :style="{ cursor: props.interactions.cursor.value }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
    @dblclick="onDoubleClick"
    @contextmenu="onContextMenu"
  >
    <canvas
      ref="backgroundCanvas"
      class="note-grid-layer"
      role="img"
      :aria-label="t.shell.pianoRoll.noteGrid"
    />
    <canvas ref="notesCanvas" class="note-grid-layer" aria-hidden="true" />
    <canvas ref="overlayCanvas" class="note-grid-layer" aria-hidden="true" />
    <AccessibleObjectNavigator
      :label="t.shell.pianoRoll.accessibility.navigator"
      :empty-label="t.shell.pianoRoll.accessibility.empty"
      :instructions="t.shell.pianoRoll.accessibility.instructions"
      :edit-label="t.shell.pianoRoll.accessibility.edit"
      :context-label="t.shell.pianoRoll.accessibility.context"
      :items="accessibleNotes"
      @activate="onAccessibleNoteActivate"
      @context="onAccessibleNoteContext"
      @adjust="onAccessibleNoteAdjust"
      @set-value="onAccessibleNoteValue"
    />
    <Teleport to="body">
      <TheoryCardView
        v-if="hoveredCard && theoryCardStyle"
        class="note-grid-theory-card"
        :card="hoveredCard"
        :style="theoryCardStyle"
        @hold="cardHold.onHold"
      />
    </Teleport>
    <div class="note-grid-live" role="status" aria-live="polite" aria-atomic="true">
      {{ liveStatus }}
    </div>
  </div>
</template>

<style scoped>
.note-grid {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
}

.note-grid-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* Theory card pinned near the note it explains. Teleported to the body and
 * fixed-positioned at the tooltip layer so no panel can cover it and the grid's
 * overflow clip cannot cut it; the card owns its visible area and a transparent
 * reach halo so the pointer can cross the fixed offset from the note. */
.note-grid-theory-card {
  position: fixed;
  z-index: 200;
  pointer-events: auto;
}

.note-grid-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>


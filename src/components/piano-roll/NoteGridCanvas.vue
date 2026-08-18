<script setup lang="ts">
import { NoteSafety } from '@libraz/libcantus';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';
import TheoryCardView from '@/components/compose/TheoryCardView.vue';
import { useTheoryCardHold } from '@/components/compose/use-theory-card-hold';
import type { ResolutionArrow } from '@/composables/useCompositionGuidance';
import { useNoteNames } from '@/composables/useNoteNames';
import type { TheoryCard } from '@/compose/explain';
import type { GuidanceSegment } from '@/compose/guidance';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import type {
  AccessibleObjectAdjustment,
  AccessibleObjectItem,
} from '@/ui/accessibility/object-navigation';
import { localizeMeter, rulerTicks } from '@/ui/arrangement/ruler';
import { observeDevicePixelRatio } from '@/ui/canvas/device-pixel-ratio';
import type { Painter } from '@/ui/canvas/painter';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import { type GhostNote, hitTestGhost } from './overlay';
import {
  DEFAULT_NOTE_COLOR,
  fillRoundRect,
  getCanvasContext,
  isBlackKey,
  type NoteColorFn,
  PIANO_ROLL_COLORS,
  setupCanvas,
  strokeRoundRect,
} from './theme';
import type {
  InteractionModifiers,
  InteractionPoint,
  NoteInteractions,
} from './use-note-interactions';
import { visibleNotesInWindow } from './visible-notes';

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
}>();

const { t } = useI18n();
const { formatPitch, system: noteNameSystem } = useNoteNames();

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
const localTimeSignatures = computed(() =>
  localizeMeter(props.timeSignatures, props.timeSignatureOriginPpq ?? 0),
);
const hoverPoint = ref<InteractionPoint | null>(null);

/** Offset of the hover theory card from the pointer, in px. */
const CARD_POINTER_OFFSET_PX = 14;
/** Assumed card extent used to keep it inside the viewport (and to flip near edges). */
const CARD_ESTIMATED_WIDTH_PX = 230;
const CARD_ESTIMATED_HEIGHT_PX = 150;

/** Theory card of the hovered note; state, so it can outlive the hover itself. */
const hoveredCard = ref<TheoryCard | null>(null);
/** Note the shown card was resolved for. */
const cardNoteId = ref<number | null>(null);
/** Local grid point the shown card is pinned at. */
const cardPoint = ref<InteractionPoint | null>(null);

const cardHold = useTheoryCardHold(() => {
  hoveredCard.value = null;
  cardNoteId.value = null;
  cardPoint.value = null;
});

/**
 * Resolves the theory card for the note under the pointer through the `noteCard`
 * prop. The card is pinned where its note was picked up — one that follows the
 * pointer can never be aimed at, so its ⓘ affordance would stay out of reach —
 * and it survives a moment off the note so that affordance can be reached.
 * Suppressed while a ghost is hovered or a gesture readout is showing, matching
 * the canvas hover HUD.
 */
function updateTheoryCard(point: InteractionPoint): void {
  if (hoveredGhost.value || (props.interactions.gestureReadout?.value ?? null)) {
    cardHold.dismiss();
    return;
  }
  const resolve = props.noteCard;
  const note = hoveredNote.value;
  if (!resolve || !note) {
    cardHold.release();
    return;
  }
  cardHold.keep();
  if (note.id === cardNoteId.value) return;
  cardNoteId.value = note.id;
  hoveredCard.value = resolve(note.id);
  cardPoint.value = point;
}

/**
 * Fixed-viewport position of the hover theory card. The card is teleported to
 * the document body (so a lower-stacking bottom panel can never cover it and the
 * grid's `overflow: hidden` can never clip it), so its coordinates are the grid
 * rect plus the pinned local point. It flips to the opposite side of that point
 * near the right/bottom viewport edges and is clamped fully on screen.
 */
const theoryCardStyle = computed<Record<string, string> | null>(() => {
  const point = cardPoint.value;
  const el = wrapper.value;
  if (!point || !el) return null;
  const rect = el.getBoundingClientRect();
  const px = rect.left + point.x;
  const py = rect.top + point.y;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = px + CARD_POINTER_OFFSET_PX;
  if (left + CARD_ESTIMATED_WIDTH_PX + 4 > vw) {
    left = px - CARD_POINTER_OFFSET_PX - CARD_ESTIMATED_WIDTH_PX;
  }
  left = Math.max(4, Math.min(left, vw - CARD_ESTIMATED_WIDTH_PX - 4));
  let top = py + CARD_POINTER_OFFSET_PX;
  if (top + CARD_ESTIMATED_HEIGHT_PX + 4 > vh) {
    top = py - CARD_POINTER_OFFSET_PX - CARD_ESTIMATED_HEIGHT_PX;
  }
  top = Math.max(4, Math.min(top, vh - CARD_ESTIMATED_HEIGHT_PX - 4));
  return { left: `${left}px`, top: `${top}px` };
});

/** Unique painter layer suffix so several editors can share one painter. */
const layerId = Math.random().toString(36).slice(2, 8);

const COLORS = PIANO_ROLL_COLORS;

/** Minimum px spacing before a vertical gridline family is drawn. */
const MIN_GRID_SPACING_PX = 6;
const LABEL_MIN_ROW_HEIGHT = 13;
const LABEL_MIN_NOTE_WIDTH = 26;
const SHORT_NOTE_WARNING_PPQ = 0.0625;

const selectedNotes = computed(() => props.notes.filter((note) => props.selection.has(note.id)));

const liveStatus = computed(() => {
  const selected = selectedNotes.value;
  const parts: string[] = [];
  if (selected.length === 0) {
    parts.push(t.value.shell.pianoRoll.accessibility.noNotesSelected);
  } else if (selected.length === 1) {
    const note = selected[0];
    parts.push(
      formatMessage(t.value.shell.pianoRoll.accessibility.noteSelected, {
        pitch: formatPitch(note.pitch),
        start: note.startPpq.toFixed(2),
        duration: note.durationPpq.toFixed(2),
      }),
    );
  } else {
    const low = Math.min(...selected.map((note) => note.pitch));
    const high = Math.max(...selected.map((note) => note.pitch));
    parts.push(
      formatMessage(t.value.shell.pianoRoll.accessibility.notesSelected, {
        count: selected.length,
        low: formatPitch(low),
        high: formatPitch(high),
      }),
    );
  }
  const hover = hoverPoint.value;
  if (hover) {
    parts.push(
      formatMessage(t.value.shell.pianoRoll.accessibility.pointerPosition, {
        ppq: props.range.xToPpq(hover.x).toFixed(2),
        pitch: formatPitch(props.range.yToPitch(hover.y)),
      }),
    );
  }
  return parts.join('. ');
});

const accessibleNotes = computed<AccessibleObjectItem[]>(() => {
  const minimumPpq = props.minPpq ?? 0;
  const step = Math.max(0.0625, props.gridPpq);
  return [...props.notes]
    .sort((a, b) => a.startPpq - b.startPpq || b.pitch - a.pitch || a.id - b.id)
    .map((note) => ({
      id: `note-${note.id}`,
      label: formatMessage(t.value.shell.pianoRoll.accessibility.note, {
        pitch: formatPitch(note.pitch),
        start: note.startPpq.toFixed(2),
        length: note.durationPpq.toFixed(2),
        velocity: note.velocity,
      }),
      selected: props.selection.has(note.id),
      controls: [
        {
          id: 'pitch',
          label: t.value.shell.pianoRoll.accessibility.pitch,
          min: 0,
          max: 127,
          step: 1,
          value: note.pitch,
          valueText: formatPitch(note.pitch),
        },
        {
          id: 'start',
          label: t.value.shell.pianoRoll.accessibility.start,
          min: minimumPpq,
          max: Math.max(minimumPpq, props.clipLengthPpq - note.durationPpq),
          step,
          value: note.startPpq,
          valueText: formatMessage(t.value.shell.pianoRoll.accessibility.ppqValue, {
            value: note.startPpq.toFixed(2),
          }),
        },
        {
          id: 'duration',
          label: t.value.shell.pianoRoll.accessibility.duration,
          min: 0.0625,
          max: Math.max(0.0625, props.clipLengthPpq - note.startPpq),
          step,
          value: note.durationPpq,
          valueText: formatMessage(t.value.shell.pianoRoll.accessibility.ppqValue, {
            value: note.durationPpq.toFixed(2),
          }),
        },
        {
          id: 'velocity',
          label: t.value.shell.pianoRoll.accessibility.velocity,
          min: 1,
          max: 127,
          step: 1,
          value: note.velocity,
        },
      ],
    }));
});

function noteForAccessibleId(id: string): EditorNote | undefined {
  const noteId = Number(id.replace(/^note-/, ''));
  return props.notes.find((note) => note.id === noteId);
}

function onAccessibleNoteActivate(id: string): void {
  const note = noteForAccessibleId(id);
  if (!note) return;
  props.interactions.cancel();
  emit('note-keyboard-action', { noteId: note.id, kind: 'select' });
}

function onAccessibleNoteContext(id: string): void {
  const note = noteForAccessibleId(id);
  if (!note) return;
  const rect = wrapper.value?.getBoundingClientRect();
  emit('note-context', {
    x: (rect?.left ?? 0) + 24,
    y: (rect?.top ?? 0) + 48,
    noteId: note.id,
    ppq: note.startPpq + note.durationPpq / 2,
  });
}

function onAccessibleNoteAdjust(adjustment: AccessibleObjectAdjustment): void {
  const note = noteForAccessibleId(adjustment.id);
  if (note) emit('note-keyboard-action', { noteId: note.id, kind: 'adjust', adjustment });
}

function onAccessibleNoteValue(payload: { id: string; controlId: string; value: number }): void {
  const note = noteForAccessibleId(payload.id);
  if (note) emit('note-keyboard-action', { noteId: note.id, kind: 'set', ...payload });
}

function scheduleBackground(): void {
  props.painter.schedule(`note-grid-background-${layerId}`, drawBackground);
}

function scheduleNotes(): void {
  props.painter.schedule(`note-grid-notes-${layerId}`, drawNotes);
}

function scheduleOverlay(): void {
  props.painter.schedule(`note-grid-overlay-${layerId}`, drawOverlay);
}

function scheduleAll(): void {
  scheduleBackground();
  scheduleNotes();
  scheduleOverlay();
}

/** Draws one family of vertical gridlines at `step` PPQ spacing. */
function drawVerticalLines(
  ctx: CanvasRenderingContext2D,
  step: number,
  color: string,
  height: number,
): void {
  if (!(step > 0) || step * props.range.pxPerPpq < MIN_GRID_SPACING_PX) return;
  ctx.fillStyle = color;
  const first = Math.ceil(props.range.startPpq / step) * step;
  for (let ppq = first; ppq < props.range.endPpq; ppq += step) {
    ctx.fillRect(Math.round(props.range.ppqToX(ppq)), 0, 1, height);
  }
}

/** Draws meter-aware beat/bar lines from the same tick model as the ruler. */
function drawMeterLines(ctx: CanvasRenderingContext2D, height: number): void {
  for (const tick of rulerTicks(
    localTimeSignatures.value,
    props.range.startPpq,
    props.range.endPpq,
    props.range.pxPerPpq,
    { minBeatSpacingPx: MIN_GRID_SPACING_PX, minBarLabelSpacingPx: Number.POSITIVE_INFINITY },
  )) {
    ctx.fillStyle = tick.kind === 'bar' ? COLORS.gridBar : COLORS.gridBeat;
    ctx.fillRect(Math.round(props.range.ppqToX(tick.ppq)), 0, 1, height);
  }
}

function overlappingNoteIds(notes: ReadonlyArray<EditorNote>): Set<number> {
  const byPitch = new Map<number, EditorNote[]>();
  for (const note of notes) {
    const group = byPitch.get(note.pitch);
    if (group) group.push(note);
    else byPitch.set(note.pitch, [note]);
  }

  const ids = new Set<number>();
  for (const group of byPitch.values()) {
    group.sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
    let active: EditorNote | null = null;
    let activeEnd = Number.NEGATIVE_INFINITY;
    for (const note of group) {
      const end = note.startPpq + note.durationPpq;
      if (active && note.startPpq < activeEnd) {
        ids.add(active.id);
        ids.add(note.id);
        if (end > activeEnd) {
          active = note;
          activeEnd = end;
        }
      } else {
        active = note;
        activeEnd = end;
      }
    }
  }
  return ids;
}

function hasScaleMask(): boolean {
  return props.highlightedPitchClasses.some(Boolean);
}

/** Draws background rows and gridlines. */
function drawBackground(): void {
  const canvas = backgroundCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const range = props.range;
  const w = range.widthPx;
  const h = range.heightPx;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, w, h);

  // Pitch rows: black-key shading, scale tint and row separators.
  const lowPitch = range.yToPitch(h - 1);
  const highPitch = range.yToPitch(0);
  for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
    const y = range.pitchToY(pitch);
    if (isBlackKey(pitch)) {
      ctx.fillStyle = COLORS.rowBlackKey;
      ctx.fillRect(0, y, w, range.rowHeight);
    }
    if (props.highlightedPitchClasses[((pitch % 12) + 12) % 12]) {
      ctx.fillStyle = COLORS.rowScale;
      ctx.fillRect(0, y, w, range.rowHeight);
    }
    if (range.rowHeight >= 5) {
      ctx.fillStyle = COLORS.rowLine;
      ctx.fillRect(0, y + range.rowHeight - 1, w, 1);
    }
  }

  // Guidance tint over the scale rows: only warning/dissonant pitch classes
  // are filled (safe rows draw nothing) so the base palette stays dominant.
  for (const segment of props.guidanceSegments ?? []) {
    const x0 = Math.max(0, range.ppqToX(segment.startBeat));
    const x1 = Math.min(w, range.ppqToX(segment.endBeat));
    if (x1 <= x0) continue;
    for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
      const safety = segment.safetyByPc[((pitch % 12) + 12) % 12];
      if (safety === NoteSafety.Safe) continue;
      ctx.fillStyle =
        safety === NoteSafety.Dissonant ? COLORS.guidanceDissonant : COLORS.guidanceWarning;
      ctx.fillRect(x0, range.pitchToY(pitch), x1 - x0, range.rowHeight);
    }
  }

  // Vertical gridlines, finest first so stronger lines draw on top.
  if (props.gridPpq < 1) drawVerticalLines(ctx, props.gridPpq, COLORS.gridFine, h);
  drawMeterLines(ctx, h);

  // Shade the region past the clip end.
  const clipEndX = range.ppqToX(props.clipLengthPpq);
  if (clipEndX < w) {
    ctx.fillStyle = COLORS.beyondClip;
    ctx.fillRect(Math.max(0, clipEndX), 0, w - Math.max(0, clipEndX), h);
  }
}

/** Draws ghost and editable note rectangles. */
function drawNotes(): void {
  const canvas = notesCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const range = props.range;
  const w = range.widthPx;
  const h = range.heightPx;
  ctx.clearRect(0, 0, w, h);
  const lowPitch = range.yToPitch(h - 1);
  const highPitch = range.yToPitch(0);

  const viewWindow = {
    startPpq: range.startPpq,
    endPpq: range.endPpq,
    minPitch: lowPitch,
    maxPitch: highPitch,
  };
  const noteH = Math.max(2, range.rowHeight - 2);

  // Ghost notes from non-active clips draw under the editable notes.
  const visibleGhosts = visibleNotesInWindow(props.ghostNotes ?? [], viewWindow);
  for (const ghost of visibleGhosts) {
    const y = range.pitchToY(ghost.pitch);
    const x = range.ppqToX(ghost.startPpq);
    const ghostW = Math.max(2, ghost.durationPpq * range.pxPerPpq - 1);
    ctx.fillStyle = ghost.color;
    fillRoundRect(ctx, x, y + 1, ghostW, noteH, 2);
  }

  // Notes: gesture preview replaces the store mirror while dragging.
  const list = props.interactions.previewNotes.value ?? props.notes;
  const visibleNotes = visibleNotesInWindow(list, viewWindow);
  const colorOf = props.noteColor ?? ((): string => DEFAULT_NOTE_COLOR);
  const scaleMaskActive = hasScaleMask();
  const overlapIds = overlappingNoteIds(visibleNotes);
  for (const note of visibleNotes) {
    const y = range.pitchToY(note.pitch);
    const x = range.ppqToX(note.startPpq);
    const noteW = Math.max(2, note.durationPpq * range.pxPerPpq - 1);
    // Negative ids mark in-flight duplicate copies; render them as selected.
    const selected = note.id < 0 || props.selection.has(note.id);
    ctx.fillStyle = colorOf(note);
    fillRoundRect(ctx, x, y + 1, noteW, noteH, 2);
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeStyle = selected ? COLORS.noteSelectedBorder : COLORS.noteBorder;
    strokeRoundRect(ctx, x + 0.5, y + 1.5, noteW - 1, noteH - 1, 2);

    const pitchClass = ((note.pitch % 12) + 12) % 12;
    const offScale = scaleMaskActive && !props.highlightedPitchClasses[pitchClass];
    const tooShort = note.durationPpq <= SHORT_NOTE_WARNING_PPQ;
    const overlap = overlapIds.has(note.id);
    if (overlap || offScale || tooShort) {
      ctx.fillStyle = overlap ? COLORS.noteError : COLORS.noteWarning;
      ctx.fillRect(x + 2, y + 2, Math.max(2, Math.min(noteW - 4, 18)), 2);
    }

    if (range.rowHeight >= LABEL_MIN_ROW_HEIGHT && noteW >= LABEL_MIN_NOTE_WIDTH) {
      ctx.fillStyle = COLORS.noteText;
      ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPitch(note.pitch), x + 5, y + range.rowHeight / 2, noteW - 8);
    }
  }
}

/** Horizontal length of a resolution arrow in px (from the note's right edge). */
const RESOLUTION_ARROW_LENGTH_PX = 16;
/** Size of the resolution arrowhead in px. */
const RESOLUTION_ARROWHEAD_PX = 4;

/**
 * Draws thin arrows from each resolving note's right edge to the row of its
 * expected resolution pitch, so voice-leading obligations (suspensions, leading
 * tones, needs-resolution notes) read at a glance. Arrows whose origin is off
 * screen or whose both endpoints sit outside the visible pitch band are culled.
 */
function drawResolutionArrows(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const arrows = props.resolutionArrows;
  if (arrows === undefined || arrows.length === 0) return;
  const range = props.range;
  const rowMid = range.rowHeight / 2;
  ctx.strokeStyle = COLORS.resolutionArrow;
  ctx.fillStyle = COLORS.resolutionArrow;
  ctx.lineWidth = 1.5;
  for (const arrow of arrows) {
    const x0 = range.ppqToX(arrow.endBeat);
    if (x0 < -RESOLUTION_ARROW_LENGTH_PX || x0 > w) continue;
    const y0 = range.pitchToY(arrow.fromPitch) + rowMid;
    const y1 = range.pitchToY(arrow.toPitch) + rowMid;
    if ((y0 < 0 && y1 < 0) || (y0 > h && y1 > h)) continue;
    const x1 = x0 + RESOLUTION_ARROW_LENGTH_PX;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // Arrowhead: a small filled triangle pointing along the arrow direction.
    const angle = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(
      x1 - RESOLUTION_ARROWHEAD_PX * Math.cos(angle - Math.PI / 6),
      y1 - RESOLUTION_ARROWHEAD_PX * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      x1 - RESOLUTION_ARROWHEAD_PX * Math.cos(angle + Math.PI / 6),
      y1 - RESOLUTION_ARROWHEAD_PX * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }
}

/** Draws the marquee rectangle and the playhead line. */
function drawOverlay(): void {
  const canvas = overlayCanvas.value;
  if (!canvas) return;
  const ctx = getCanvasContext(canvas);
  if (!ctx) return;
  const w = props.range.widthPx;
  const h = props.range.heightPx;
  ctx.clearRect(0, 0, w, h);

  drawResolutionArrows(ctx, w, h);

  const m = props.interactions.marquee.value;
  if (m) {
    const x = Math.min(m.x, m.x + m.width);
    const y = Math.min(m.y, m.y + m.height);
    const mw = Math.abs(m.width);
    const mh = Math.abs(m.height);
    ctx.fillStyle = COLORS.marqueeFill;
    ctx.fillRect(x, y, mw, mh);
    ctx.strokeStyle = COLORS.marqueeStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, mw, mh);
  }

  const readout = props.interactions.gestureReadout?.value ?? null;
  if (readout) {
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.label);
    const paddingX = 7;
    const paddingY = 4;
    const metrics = ctx.measureText(readout.text);
    const boxW = metrics.width + paddingX * 2;
    const boxH = 20;
    const x = Math.min(Math.max(4, readout.x), w - boxW - 4);
    const y = Math.min(Math.max(4, readout.y), h - boxH - 4);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, x, y, boxW, boxH, 4);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(readout.text, x + paddingX, y + boxH / 2 + paddingY * 0.05);
  }

  const ghost = hoveredGhost.value;
  if (ghost) {
    const x = props.range.ppqToX(ghost.startPpq);
    const y = props.range.pitchToY(ghost.pitch);
    const ghostW = Math.max(2, ghost.durationPpq * props.range.pxPerPpq - 1);
    const noteH = Math.max(2, props.range.rowHeight - 2);
    ctx.strokeStyle = COLORS.noteSelectedBorder;
    ctx.lineWidth = 1.5;
    strokeRoundRect(ctx, x + 0.5, y + 1.5, ghostW - 1, noteH - 1, 2);
    const text = `${ghost.trackName} · ${formatPitch(ghost.pitch)}`;
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.label);
    const boxW = ctx.measureText(text).width + 14;
    const boxH = 20;
    const labelX = Math.min(Math.max(4, x + 8), w - boxW - 4);
    const labelY = Math.min(Math.max(4, y - 22), h - boxH - 4);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, labelX, labelY, boxW, boxH, 4);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, labelX + 7, labelY + boxH / 2);
  }

  // Hover HUD for the active layer, matching the ghost note's. Suppressed while
  // a ghost is hovered (its own HUD wins) or a gesture readout is showing, and
  // while the theory card is up — the card's title already carries the pitch and
  // velocity, so the two would otherwise duplicate.
  const hoverNote = hoveredNote.value;
  if (!ghost && !readout && hoverNote && !hoveredCard.value) {
    const x = props.range.ppqToX(hoverNote.startPpq);
    const y = props.range.pitchToY(hoverNote.pitch);
    const text = `${formatPitch(hoverNote.pitch)} · vel ${hoverNote.velocity}`;
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.label);
    const boxW = ctx.measureText(text).width + 14;
    const boxH = 20;
    const labelX = Math.min(Math.max(4, x + 8), w - boxW - 4);
    const labelY = Math.min(Math.max(4, y - 22), h - boxH - 4);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, labelX, labelY, boxW, boxH, 4);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, labelX + 7, labelY + boxH / 2);
  }

  const guide = hoverPoint.value;
  if (guide) {
    ctx.strokeStyle = COLORS.rulerBeat;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(guide.x) + 0.5, 0);
    ctx.lineTo(Math.round(guide.x) + 0.5, h);
    ctx.moveTo(0, Math.round(guide.y) + 0.5);
    ctx.lineTo(w, Math.round(guide.y) + 0.5);
    ctx.stroke();
  }

  if (props.positionPpq) {
    // While following, the line moves normally until it reaches the anchor, then
    // the cap pins it there and the notes scroll under it, keeping it aligned
    // with the arrangement's playhead.
    const raw = props.range.ppqToX(props.positionPpq());
    const anchor = props.anchoredLocalX?.() ?? null;
    const x = anchor === null ? raw : Math.min(raw, anchor);
    if (x >= 0 && x <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(x), 0, 1.5, h);
    }
  }
}

// Playhead polling: redraw the overlay only when the playhead px moved.
let playheadRaf: number | null = null;
let lastPlayheadX = Number.NaN;

function playheadTick(): void {
  const getter = props.positionPpq;
  if (getter) {
    const raw = props.range.ppqToX(getter());
    const anchor = props.anchoredLocalX?.() ?? null;
    const x = anchor === null ? raw : Math.min(raw, anchor);
    if (x !== lastPlayheadX) {
      lastPlayheadX = x;
      scheduleOverlay();
    }
  }
  playheadRaf = requestAnimationFrame(playheadTick);
}

let resizeObserver: ResizeObserver | null = null;
let stopDprObserver: (() => void) | null = null;

function refreshForDevicePixelRatio(): void {
  const { widthPx, heightPx } = props.range;
  if (widthPx <= 0 || heightPx <= 0) return;
  if (backgroundCanvas.value) setupCanvas(backgroundCanvas.value, widthPx, heightPx);
  if (notesCanvas.value) setupCanvas(notesCanvas.value, widthPx, heightPx);
  if (overlayCanvas.value) setupCanvas(overlayCanvas.value, widthPx, heightPx);
  scheduleAll();
}

onMounted(() => {
  const el = wrapper.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (w <= 0 || h <= 0) return;
    props.range.resize(w, h);
    if (backgroundCanvas.value) setupCanvas(backgroundCanvas.value, w, h);
    if (notesCanvas.value) setupCanvas(notesCanvas.value, w, h);
    if (overlayCanvas.value) setupCanvas(overlayCanvas.value, w, h);
    emit('view-resize', w, h);
    scheduleAll();
  });
  resizeObserver.observe(el);
  stopDprObserver = observeDevicePixelRatio(refreshForDevicePixelRatio);
  playheadRaf = requestAnimationFrame(playheadTick);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  stopDprObserver?.();
  stopDprObserver = null;
  if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
});

watch(
  () => [
    props.revision,
    props.highlightedPitchClasses,
    props.gridPpq,
    props.clipLengthPpq,
    props.timeSignatures,
    props.timeSignatureOriginPpq,
    props.guidanceSegments,
  ],
  () => {
    lastPlayheadX = Number.NaN;
    scheduleBackground();
    scheduleNotes();
    scheduleOverlay();
  },
);

watch(
  () => [props.notes, props.ghostNotes, props.noteColor, props.interactions.previewNotes.value],
  () => {
    scheduleNotes();
    scheduleOverlay();
  },
);

watch(
  () => props.resolutionArrows,
  () => scheduleOverlay(),
);

// Note and overlay labels carry pitch names, which the canvas layers cache in
// their painted output; a renamed system has to repaint them.
watch(noteNameSystem, () => {
  scheduleNotes();
  scheduleOverlay();
});

watch(
  () => props.selection,
  () => {
    scheduleNotes();
  },
);

watch(
  () =>
    [
      props.interactions.marquee.value,
      props.interactions.gestureReadout?.value ?? null,
      hoveredGhost.value,
      hoveredNote.value,
      hoverPoint.value,
      // The card outlives the hover, so its own comings and goings drive the
      // HUD suppression the overlay applies while it is up.
      hoveredCard.value,
    ] as const,
  () => scheduleOverlay(),
);

function localPoint(event: MouseEvent): InteractionPoint {
  const rect = wrapper.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function modifiers(event: MouseEvent): InteractionModifiers {
  return { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey };
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const point = localPoint(event);
  const mods = modifiers(event);
  // A press on a ghost note requests track/clip activation instead of an
  // editing gesture; alt keeps the current track and edits normally.
  if (!mods.alt) {
    const ghost = hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
    if (ghost) {
      emit('ghost-activate', ghost);
      return;
    }
  }
  props.interactions.onPointerDown(point, mods);
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  const mods = modifiers(event);
  hoveredGhost.value = mods.alt
    ? null
    : hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
  // Mirror the ghost-note hover HUD for the active layer: surface the editable
  // note under the pointer so hovering an active note reads it out too. The
  // overlay suppresses it while a ghost is hovered or a gesture is in flight.
  if (hoveredGhost.value) {
    hoveredNote.value = null;
  } else {
    const hitId = props.interactions.hitNoteAt(point);
    hoveredNote.value =
      hitId === null ? null : (props.notes.find((note) => note.id === hitId) ?? null);
  }
  hoverPoint.value = point;
  updateTheoryCard(point);
  emit('hover-status', {
    ppq: Math.max(0, props.range.xToPpq(point.x)),
    pitch: props.range.yToPitch(point.y),
  });
  props.interactions.onPointerMove(point, mods);
}

function onPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  props.interactions.onPointerUp(localPoint(event), modifiers(event));
}

function onPointerCancel(): void {
  hoveredGhost.value = null;
  hoveredNote.value = null;
  hoverPoint.value = null;
  cardHold.dismiss();
  emit('hover-status', null);
  props.interactions.cancel();
}

function onPointerLeave(): void {
  hoveredGhost.value = null;
  hoveredNote.value = null;
  hoverPoint.value = null;
  // The card is teleported outside the grid, so reaching its ⓘ leaves the grid
  // too; the grace period is what lets the pointer get there.
  cardHold.release();
  emit('hover-status', null);
  scheduleOverlay();
}

function onDoubleClick(event: MouseEvent): void {
  props.interactions.onDoubleClick(localPoint(event), modifiers(event));
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const point = localPoint(event);
  emit('note-context', {
    x: event.clientX,
    y: event.clientY,
    noteId: props.interactions.hitNoteAt(point),
    ppq: Math.max(0, props.range.xToPpq(point.x)),
  });
}
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
 * overflow clip cannot cut it; the card ignores the pointer so it can never
 * block a gesture, while its ⓘ affordance opts back in to stay clickable. */
.note-grid-theory-card {
  position: fixed;
  z-index: 200;
  pointer-events: none;
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

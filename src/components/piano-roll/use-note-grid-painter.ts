/**
 * Layered painter of the note grid: background rows and gridlines, ghost and
 * editable notes, and the overlay (placement column, marquee, HUD pills,
 * crosshair, playhead). Each layer repaints through the shared frame batcher
 * from an explicit watch list, and a requestAnimationFrame poll repaints the
 * overlay only when the playhead moved a pixel.
 */

import { NoteSafety } from '@libraz/libcantus';
import { onBeforeUnmount, onMounted, type Ref, watch } from 'vue';
import type { ResolutionArrow } from '@/composables/useCompositionGuidance';
import { useNoteNames } from '@/composables/useNoteNames';
import type { PlacementColumn } from '@/composables/usePlacementGuidance';
import type { TheoryCard } from '@/compose/explain';
import type { GuidanceSegment } from '@/compose/guidance';
import { pitchClassOf } from '@/lib/pitch';
import { meterGridLines } from '@/project/time-signature';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import { MIN_NOTE_WIDTH_PX } from '@/ui/canvas/hit-test';
import type { Painter } from '@/ui/canvas/painter';
import { playheadX } from '@/ui/canvas/playhead-x';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { createLayerId, useCanvasSurface } from '@/ui/canvas/use-canvas-surface';
import { CANVAS_FONT_SIZE_PX, canvasFont } from '@/ui/theme/tokens';
import { drawPlacementColumn, drawResolutionArrows } from './guidance-overlay-paint';
import type { GhostNote } from './overlay';
import {
  DEFAULT_NOTE_COLOR,
  fillRoundRect,
  getCanvasContext,
  isBlackKey,
  type NoteColorFn,
  PIANO_ROLL_COLORS,
  strokeRoundRect,
} from './theme';
import { localRulerTicks } from './timeline-meter';
import type { InteractionPoint, NoteInteractions } from './use-note-interactions';
import { visibleNotesInWindow } from './visible-notes';

/** Configuration for {@link useNoteGridPainter}. */
export interface UseNoteGridPainterOptions {
  /** Grid props every layer paints from. */
  props: {
    readonly range: TimelineRange;
    readonly revision: number;
    readonly painter: Painter;
    readonly notes: EditorNote[];
    readonly selection: Set<number>;
    readonly highlightedPitchClasses: boolean[];
    readonly gridPpq: number;
    readonly clipLengthPpq: number;
    readonly timeSignatures: TimeSignatureSegment[];
    readonly timeSignatureOriginPpq?: number;
    readonly interactions: NoteInteractions;
    readonly positionPpq?: () => number;
    readonly anchoredLocalX?: () => number | null;
    readonly noteColor?: NoteColorFn;
    readonly ghostNotes?: GhostNote[];
    readonly guidanceSegments?: GuidanceSegment[];
    readonly resolutionArrows?: ResolutionArrow[];
    readonly noteSafety?: ReadonlyMap<number, NoteSafety.Warning | NoteSafety.Dissonant>;
    readonly placementColumn?: PlacementColumn | null;
    readonly unresolvedNoteIds?: ReadonlySet<number>;
  };
  /** Grid emit for the viewport resize. */
  emit: (event: 'view-resize', widthPx: number, heightPx: number) => void;
  /** Grid root element whose size drives the canvases. */
  wrapper: Ref<HTMLDivElement | null>;
  /** Background layer canvas (rows and gridlines). */
  backgroundCanvas: Ref<HTMLCanvasElement | null>;
  /** Note layer canvas. */
  notesCanvas: Ref<HTMLCanvasElement | null>;
  /** Overlay layer canvas. */
  overlayCanvas: Ref<HTMLCanvasElement | null>;
  /** Ghost note under the pointer. */
  hoveredGhost: Ref<GhostNote | null>;
  /** Editable note under the pointer during a passive hover. */
  hoveredNote: Ref<EditorNote | null>;
  /** Local pointer position over the grid, or null off it. */
  hoverPoint: Ref<InteractionPoint | null>;
  /** Shown theory card; suppresses the hover HUD while up. */
  hoveredCard: Ref<TheoryCard | null>;
}

/** Repaint entry point returned by {@link useNoteGridPainter}. */
export interface NoteGridPainter {
  /** Schedules an overlay-layer repaint. */
  scheduleOverlay(): void;
}

/**
 * Wires the three canvas layers of one note grid to the shared painter.
 *
 * @param options - The grid props, emit, canvases and hover state.
 * @returns The overlay repaint scheduler.
 */
export function useNoteGridPainter(options: UseNoteGridPainterOptions): NoteGridPainter {
  const {
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
  } = options;
  const { formatPitch, system: noteNameSystem } = useNoteNames();

  /** Unique painter layer suffix so several editors can share one painter. */
  const layerId = createLayerId();

  const COLORS = PIANO_ROLL_COLORS;

  /** Minimum px spacing before a vertical gridline family is drawn. */
  const MIN_GRID_SPACING_PX = 6;
  const LABEL_MIN_ROW_HEIGHT = 13;
  const LABEL_MIN_NOTE_WIDTH = 26;
  const SHORT_NOTE_WARNING_PPQ = 0.0625;

  /** HUD pill metrics (px): height, horizontal text padding, corner radius, canvas-edge margin. */
  const HUD_HEIGHT_PX = 20;
  const HUD_PADDING_X = 7;
  const HUD_RADIUS_PX = 4;
  const HUD_MARGIN_PX = 4;
  /** Offset of a note-anchored HUD pill from the note's top-left corner. */
  const HUD_ANCHOR_OFFSET_X = 8;
  const HUD_ANCHOR_OFFSET_Y = -22;

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

  /** Draws one family of vertical gridlines on the timeline meter grid the snap uses. */
  function drawVerticalLines(
    ctx: CanvasRenderingContext2D,
    step: number,
    color: string,
    height: number,
  ): void {
    if (!(step > 0) || step * props.range.pxPerPpq < MIN_GRID_SPACING_PX) return;
    ctx.fillStyle = color;
    const origin = props.timeSignatureOriginPpq ?? 0;
    for (const ppq of meterGridLines(
      props.timeSignatures,
      props.range.startPpq + origin,
      props.range.endPpq + origin,
      step,
    )) {
      ctx.fillRect(Math.round(props.range.ppqToX(ppq - origin)), 0, 1, height);
    }
  }

  /** Draws meter-aware beat/bar lines from the same tick model as the ruler. */
  function drawMeterLines(ctx: CanvasRenderingContext2D, height: number): void {
    for (const tick of localRulerTicks(
      props.timeSignatures,
      props.timeSignatureOriginPpq ?? 0,
      props.range.startPpq,
      props.range.endPpq,
      props.range.pxPerPpq,
      { minBeatSpacingPx: MIN_GRID_SPACING_PX, minBarLabelSpacingPx: Number.POSITIVE_INFINITY },
    )) {
      ctx.fillStyle = tick.kind === 'bar' ? COLORS.gridBar : COLORS.gridBeat;
      ctx.fillRect(Math.round(props.range.ppqToX(tick.ppq)), 0, 1, height);
    }
  }

  const overlapCache = new WeakMap<ReadonlyArray<EditorNote>, Set<number>>();

  /** Ids of same-pitch notes that overlap in time; cached per (immutable) note array. */
  function overlappingNoteIds(notes: ReadonlyArray<EditorNote>): Set<number> {
    const cached = overlapCache.get(notes);
    if (cached) return cached;
    const ids = findOverlappingNoteIds(notes);
    overlapCache.set(notes, ids);
    return ids;
  }

  function findOverlappingNoteIds(notes: ReadonlyArray<EditorNote>): Set<number> {
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
      if (props.highlightedPitchClasses[pitchClassOf(pitch)]) {
        ctx.fillStyle = COLORS.rowScale;
        ctx.fillRect(0, y, w, range.rowHeight);
      }
      if (range.rowHeight >= 5) {
        ctx.fillStyle = COLORS.rowLine;
        ctx.fillRect(0, y + range.rowHeight - 1, w, 1);
      }
    }

    // Guidance tint over the scale rows. Safe rows use a very light tint so the
    // recommended area is visible without washing out the key and black-key
    // structure; no-chord clips omit guidanceSegments altogether.
    for (const segment of props.guidanceSegments ?? []) {
      const x0 = Math.max(0, range.ppqToX(segment.startBeat));
      const x1 = Math.min(w, range.ppqToX(segment.endBeat));
      if (x1 <= x0) continue;
      for (let pitch = lowPitch; pitch <= highPitch; pitch++) {
        const safety = segment.safetyByPc[pitchClassOf(pitch)];
        ctx.fillStyle =
          safety === NoteSafety.Safe
            ? COLORS.guidanceSafe
            : safety === NoteSafety.Dissonant
              ? COLORS.guidanceDissonant
              : COLORS.guidanceWarning;
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
      const ghostW = Math.max(MIN_NOTE_WIDTH_PX, ghost.durationPpq * range.pxPerPpq - 1);
      ctx.fillStyle = ghost.color;
      fillRoundRect(ctx, x, y + 1, ghostW, noteH, 2);
    }

    // Notes: gesture preview replaces the store mirror while dragging.
    const list = props.interactions.previewNotes.value ?? props.notes;
    const visibleNotes = visibleNotesInWindow(list, viewWindow);
    const colorOf = props.noteColor ?? ((): string => DEFAULT_NOTE_COLOR);
    const scaleMaskActive = hasScaleMask();
    const overlapIds = overlappingNoteIds(list);
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.meta);
    ctx.textBaseline = 'middle';
    for (const note of visibleNotes) {
      const y = range.pitchToY(note.pitch);
      const x = range.ppqToX(note.startPpq);
      const noteW = Math.max(MIN_NOTE_WIDTH_PX, note.durationPpq * range.pxPerPpq - 1);
      // Negative ids mark in-flight duplicate copies; render them as selected.
      const selected = note.id < 0 || props.selection.has(note.id);
      ctx.fillStyle = colorOf(note);
      fillRoundRect(ctx, x, y + 1, noteW, noteH, 2);
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.strokeStyle = selected ? COLORS.noteSelectedBorder : COLORS.noteBorder;
      strokeRoundRect(ctx, x + 0.5, y + 1.5, noteW - 1, noteH - 1, 2);

      const pitchClass = pitchClassOf(note.pitch);
      const offScale = scaleMaskActive && !props.highlightedPitchClasses[pitchClass];
      const tooShort = note.durationPpq <= SHORT_NOTE_WARNING_PPQ;
      const overlap = overlapIds.has(note.id);
      const safety = props.noteSafety?.get(note.id);
      const harmonicWarning = safety === NoteSafety.Warning;
      const dissonant = safety === NoteSafety.Dissonant;
      const unresolved = props.unresolvedNoteIds?.has(note.id) === true;
      if (overlap || harmonicWarning || dissonant || offScale || tooShort || unresolved) {
        // Overlaps and harmonic dissonance are errors; all other guidance is a
        // caution. Keep the priority explicit so a harmless scale warning can
        // never hide an overlap or a chord clash.
        ctx.fillStyle = overlap || dissonant ? COLORS.noteError : COLORS.noteWarning;
        // A harmony warning belongs to the entire sounding note. A short mark
        // is reserved for local edit issues such as overlaps and tiny notes.
        const warningWidth = harmonicWarning || dissonant ? noteW - 4 : Math.min(noteW - 4, 18);
        ctx.fillRect(x + 2, y + 2, Math.max(2, warningWidth), 2);
      }

      if (range.rowHeight >= LABEL_MIN_ROW_HEIGHT && noteW >= LABEL_MIN_NOTE_WIDTH) {
        ctx.fillStyle = COLORS.noteText;
        ctx.fillText(formatPitch(note.pitch), x + 5, y + range.rowHeight / 2, noteW - 8);
      }
    }
  }

  /** Draws a HUD pill with its top-left near (x, y), clamped inside the w x h canvas. */
  function drawHudLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    ctx.font = canvasFont(CANVAS_FONT_SIZE_PX.label);
    const boxW = ctx.measureText(text).width + HUD_PADDING_X * 2;
    const left = Math.min(Math.max(HUD_MARGIN_PX, x), w - boxW - HUD_MARGIN_PX);
    const top = Math.min(Math.max(HUD_MARGIN_PX, y), h - HUD_HEIGHT_PX - HUD_MARGIN_PX);
    ctx.fillStyle = COLORS.hudBackground;
    fillRoundRect(ctx, left, top, boxW, HUD_HEIGHT_PX, HUD_RADIUS_PX);
    ctx.fillStyle = COLORS.hudText;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + HUD_PADDING_X, top + HUD_HEIGHT_PX / 2);
  }

  /** Draws the placement column, marquee, readouts, crosshair and playhead line. */
  function drawOverlay(): void {
    const canvas = overlayCanvas.value;
    if (!canvas) return;
    const ctx = getCanvasContext(canvas);
    if (!ctx) return;
    const w = props.range.widthPx;
    const h = props.range.heightPx;
    ctx.clearRect(0, 0, w, h);

    drawPlacementColumn(
      ctx,
      props.range,
      props.placementColumn,
      hoverPoint.value ? props.range.yToPitch(hoverPoint.value.y) : null,
      w,
      h,
    );
    drawResolutionArrows(ctx, props.range, props.resolutionArrows, w, h);

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
      drawHudLabel(ctx, readout.text, readout.x, readout.y, w, h);
    }

    const ghost = hoveredGhost.value;
    if (ghost) {
      const x = props.range.ppqToX(ghost.startPpq);
      const y = props.range.pitchToY(ghost.pitch);
      const ghostW = Math.max(MIN_NOTE_WIDTH_PX, ghost.durationPpq * props.range.pxPerPpq - 1);
      const noteH = Math.max(2, props.range.rowHeight - 2);
      ctx.strokeStyle = COLORS.noteSelectedBorder;
      ctx.lineWidth = 1.5;
      strokeRoundRect(ctx, x + 0.5, y + 1.5, ghostW - 1, noteH - 1, 2);
      drawHudLabel(
        ctx,
        `${ghost.trackName} · ${formatPitch(ghost.pitch)}`,
        x + HUD_ANCHOR_OFFSET_X,
        y + HUD_ANCHOR_OFFSET_Y,
        w,
        h,
      );
    }

    // Hover HUD for the active layer, matching the ghost note's. Suppressed while
    // a ghost is hovered (its own HUD wins) or a gesture readout is showing, and
    // while the theory card is up — the card's title already carries the pitch and
    // velocity, so the two would otherwise duplicate.
    const hoverNote = hoveredNote.value;
    if (!ghost && !readout && hoverNote && !hoveredCard.value) {
      const x = props.range.ppqToX(hoverNote.startPpq);
      const y = props.range.pitchToY(hoverNote.pitch);
      drawHudLabel(
        ctx,
        `${formatPitch(hoverNote.pitch)} · vel ${hoverNote.velocity}`,
        x + HUD_ANCHOR_OFFSET_X,
        y + HUD_ANCHOR_OFFSET_Y,
        w,
        h,
      );
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
      const x = playheadX(props.range, props.positionPpq(), props.anchoredLocalX?.() ?? null);
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
      const x = playheadX(props.range, getter(), props.anchoredLocalX?.() ?? null);
      if (x !== lastPlayheadX) {
        lastPlayheadX = x;
        scheduleOverlay();
      }
    }
    playheadRaf = requestAnimationFrame(playheadTick);
  }

  useCanvasSurface({
    container: wrapper,
    canvases: () => [backgroundCanvas.value, notesCanvas.value, overlayCanvas.value],
    onResize: (w, h) => {
      props.range.resize(w, h);
      emit('view-resize', w, h);
    },
    redraw: scheduleAll,
  });

  onMounted(() => {
    playheadRaf = requestAnimationFrame(playheadTick);
  });

  onBeforeUnmount(() => {
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
    () => [
      props.notes,
      props.ghostNotes,
      props.noteColor,
      props.noteSafety,
      props.unresolvedNoteIds,
      props.interactions.previewNotes.value,
    ],
    () => {
      scheduleNotes();
      scheduleOverlay();
    },
  );

  watch(
    () => [props.resolutionArrows, props.placementColumn],
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

  return { scheduleOverlay };
}

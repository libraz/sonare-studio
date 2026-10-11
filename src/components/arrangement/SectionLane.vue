<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { duplicateTime, setSections } from '@/project/commands';
import { partForTrack } from '@/project/generation';
import { useProjectStore } from '@/project/store';
import { type EditorSection, TRACK_COLOR_PALETTE } from '@/project/types';
import { barRangeAt, nearestBarPpq } from '@/ui/arrangement/ruler';
import { clampSectionEdge, newSectionSpan, sectionIndexAt } from '@/ui/arrangement/sections';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { openContextMenu } from '@/ui/menu/context-menu';
import { colorWithAlpha } from './theme';

/**
 * Thin section lane above the arrangement ruler: colored named bands from the
 * store's section list. Click a band to seek to its start, double-click a
 * band to rename it inline, double-click empty space to create a section
 * spanning to the next one, and drag a band edge to resize (snapped to bars).
 * All edits go through the setSections command.
 */

const props = defineProps<{
  /** Shared timeline viewport (read-only here; the canvas owns resizing). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
  /** Open drum generation with this section as the replacement range. */
  regenerateDrums: [sectionId: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const wrapper = ref<HTMLDivElement | null>(null);

/** Px distance from a band edge treated as a resize handle. */
const EDGE_TOLERANCE_PX = 5;
/** Px a pointer must travel before an edge press becomes a resize drag. */
const DRAG_THRESHOLD_PX = 3;
/** Bars a new section spans when no section follows it. */
const DEFAULT_SECTION_BARS = 4;

// --- Edge resize -----------------------------------------------------------

interface ResizeDrag {
  sectionId: number;
  edge: 'start' | 'end';
  startClientX: number;
  moved: boolean;
}

let resizeDrag: ResizeDrag | null = null;

/** Set when a resize drag commits, so the trailing click does not seek. */
let suppressClick = false;

/** Live preview of the resized section while a drag runs. */
const resizePreview = ref<{ id: number; startPpq: number; endPpq: number } | null>(null);

// --- Inline rename ---------------------------------------------------------

const editingSectionId = ref(-1);
const editName = ref('');
const nameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);
let renameFocusFrame: number | null = null;

/** One positioned band in the lane. */
interface SectionBand {
  id: number;
  name: string;
  color: string;
  startPpq: number;
  endPpq: number;
  leftPx: number;
  widthPx: number;
}

const bands = computed<SectionBand[]>(() => {
  void props.revision;
  const preview = resizePreview.value;
  const out: SectionBand[] = [];
  for (const section of store.sections) {
    const startPpq = preview?.id === section.id ? preview.startPpq : section.startPpq;
    const endPpq = preview?.id === section.id ? preview.endPpq : section.endPpq;
    const leftPx = props.range.ppqToX(startPpq);
    const widthPx = (endPpq - startPpq) * props.range.pxPerPpq;
    if (leftPx + widthPx <= 0 || leftPx >= props.range.widthPx) continue;
    out.push({
      id: section.id,
      name: section.name,
      color: section.color,
      startPpq,
      endPpq,
      leftPx,
      widthPx,
    });
  }
  return out;
});

function localX(event: MouseEvent): number {
  const rect = wrapper.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

function sectionIndexById(sectionId: number): number {
  return store.sections.findIndex((section) => section.id === sectionId);
}

function onBandPointerDown(band: SectionBand, event: PointerEvent): void {
  if (event.button !== 0 || editingSectionId.value === band.id) return;
  const offsetX = localX(event) - band.leftPx;
  const edge: 'start' | 'end' | null =
    offsetX <= EDGE_TOLERANCE_PX
      ? 'start'
      : offsetX >= band.widthPx - EDGE_TOLERANCE_PX
        ? 'end'
        : null;
  if (!edge) return; // plain click handled by the click handler
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  resizeDrag = { sectionId: band.id, edge, startClientX: event.clientX, moved: false };
}

function onBandPointerMove(event: PointerEvent): void {
  const drag = resizeDrag;
  if (!drag) return;
  if (!drag.moved && Math.abs(event.clientX - drag.startClientX) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  const index = sectionIndexById(drag.sectionId);
  const section = store.sections[index];
  if (!section) return;
  const rawPpq = props.range.xToPpq(localX(event));
  const snapped = nearestBarPpq(store.timeSignatures, rawPpq);
  const clamped = clampSectionEdge(store.sections, index, drag.edge, snapped);
  resizePreview.value =
    drag.edge === 'start'
      ? { id: section.id, startPpq: clamped, endPpq: section.endPpq }
      : { id: section.id, startPpq: section.startPpq, endPpq: clamped };
}

function onBandPointerUp(): void {
  const drag = resizeDrag;
  const preview = resizePreview.value;
  resizeDrag = null;
  resizePreview.value = null;
  if (!drag?.moved || !preview) return;
  suppressClick = true;
  const section = store.sections.find((s) => s.id === drag.sectionId);
  if (!section) return;
  if (section.startPpq === preview.startPpq && section.endPpq === preview.endPpq) return;
  setSections(
    store.sections.map((s) =>
      s.id === drag.sectionId
        ? { ...s, startPpq: preview.startPpq, endPpq: preview.endPpq }
        : { ...s },
    ),
  );
}

function onBandPointerCancel(): void {
  resizeDrag = null;
  resizePreview.value = null;
}

function onBandClick(band: SectionBand, event: MouseEvent): void {
  // Edge drags swallow their trailing click; treat the rest as seek.
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const offsetX = localX(event) - band.leftPx;
  if (offsetX <= EDGE_TOLERANCE_PX || offsetX >= band.widthPx - EDGE_TOLERANCE_PX) return;
  emit('seek', Math.max(0, band.startPpq));
}

/** Mirrors the host's drum-track lookup so the menu says why it cannot vary drums. */
const drumsBlocked = computed(() =>
  firstBlock([
    !store.tracks.some(
      (track) =>
        track.kind === 'midi' &&
        track.frozen === undefined &&
        (partForTrack(track) === 'drums' || track.percussion === true),
    ),
    t.value.shell.arrangement.regenerateSectionDrumsNoTrack,
  ]),
);

function onBandContextMenu(band: SectionBand, event: MouseEvent): void {
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY, [
    {
      id: 'regenerate-section-drums',
      label: t.value.shell.arrangement.regenerateSectionDrums,
      disabledReason: drumsBlocked.value,
      run: () => emit('regenerateDrums', band.id),
    },
    {
      id: 'duplicate-section',
      label: t.value.shell.arrangement.duplicateSection,
      run: () => duplicateTime(band.startPpq, band.endPpq),
    },
  ]);
}

function startRename(band: SectionBand): void {
  editingSectionId.value = band.id;
  editName.value = band.name;
  if (renameFocusFrame !== null) cancelAnimationFrame(renameFocusFrame);
  renameFocusFrame = requestAnimationFrame(() => {
    renameFocusFrame = null;
    const el = nameInput.value;
    const input = Array.isArray(el) ? el[0] : el;
    input?.focus();
    input?.select();
  });
}

function commitRename(): void {
  const sectionId = editingSectionId.value;
  editingSectionId.value = -1;
  if (sectionId < 0) return;
  const name = editName.value.trim();
  if (name.length === 0) return;
  const current = store.sections.find((section) => section.id === sectionId);
  if (!current || current.name === name) return;
  setSections(store.sections.map((s) => (s.id === sectionId ? { ...s, name } : { ...s })));
}

function cancelRename(): void {
  editingSectionId.value = -1;
}

onBeforeUnmount(() => {
  if (renameFocusFrame !== null) {
    cancelAnimationFrame(renameFocusFrame);
    renameFocusFrame = null;
  }
});

/** Creates a section in the empty gap under a double-click. */
function onLaneDoubleClick(event: MouseEvent): void {
  if (event.target !== wrapper.value) return;
  const ppq = Math.max(0, props.range.xToPpq(localX(event)));
  const sections: EditorSection[] = store.sections;
  if (sectionIndexAt(sections, ppq) !== -1) return;
  const bar = barRangeAt(store.timeSignatures, ppq);
  const span = newSectionSpan(sections, ppq, bar.startPpq, bar.lengthPpq * DEFAULT_SECTION_BARS);
  if (!span) return;
  const color = TRACK_COLOR_PALETTE[sections.length % TRACK_COLOR_PALETTE.length];
  setSections([
    ...sections.map((s) => ({ ...s })),
    {
      name: `Section ${sections.length + 1}`,
      color,
      startPpq: span.startPpq,
      endPpq: span.endPpq,
    },
  ]);
}
</script>

<template>
  <div ref="wrapper" class="section-lane" @dblclick="onLaneDoubleClick">
    <div
      v-for="band in bands"
      :key="band.id"
      class="section-band"
      :style="{
        left: `${band.leftPx}px`,
        width: `${Math.max(2, band.widthPx)}px`,
        background: colorWithAlpha(band.color, 0.3),
        borderColor: band.color,
      }"
      @pointerdown="onBandPointerDown(band, $event)"
      @pointermove="onBandPointerMove"
      @pointerup="onBandPointerUp"
      @pointercancel="onBandPointerCancel"
      @click="onBandClick(band, $event)"
      @contextmenu="onBandContextMenu(band, $event)"
      @dblclick.stop="startRename(band)"
      v-tooltip="editingSectionId === band.id ? null : t.shell.arrangement.sectionBandTitle"
    >
      <input
        v-if="editingSectionId === band.id"
        ref="nameInput"
        v-model="editName"
        class="section-name-input"
        :aria-label="t.shell.arrangement.sectionName"
        @click.stop
        @pointerdown.stop
        @keydown.enter.prevent="commitRename"
        @keydown.escape.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="section-name">{{ band.name }}</span>
    </div>
    <span v-if="store.sections.length === 0" class="section-hint">
      {{ t.shell.arrangement.sectionEmptyHint }}
    </span>
  </div>
</template>

<style scoped>
.section-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-strong);
}

.section-band {
  position: absolute;
  top: 2px;
  bottom: 2px;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  border: 1px solid;
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-2);
  overflow: hidden;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  transition: filter var(--dur-1) var(--ease-out);
}

.section-band:hover {
  filter: brightness(1.2);
}

.section-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-1);
}

.section-name-input {
  width: 100%;
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-1);
  background: var(--surface-0);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 0 2px;
}
.section-hint {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--sp-2);
  display: flex;
  align-items: center;
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-4);
  white-space: nowrap;
  pointer-events: none;
}
</style>

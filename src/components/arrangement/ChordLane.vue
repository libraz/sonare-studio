<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { EditorChordSymbol } from '@/project/chords';
import { formatChordName } from '@/project/chords';
import {
  barRangeAt,
  DEFAULT_MIN_BAR_LABEL_SPACING_PX,
  type MeterSegment,
} from '@/ui/arrangement/ruler';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Thin, always-visible lane showing the project chord track as repeating
 * labeled bands, shared by the arrangement view and the piano roll (with a
 * clip-relative `originPpq` shift for the latter). Modeled on SectionLane:
 * same culling/positioning discipline, same visual language as a neutral
 * sibling lane. Read-only — a click seeks, a double-click asks the host to
 * open the chord list editor where chords are actually edited.
 *
 * A long chord's band stays one continuous region, but its name label
 * re-tiles at bar boundaries (density- and tail-guarded) so it stays legible
 * while scrolled. `hasContent` (arrangement only) drives the "chords are a
 * guide, tracks are still empty" hint that teaches the chords/tracks
 * distinction the moment a progression is generated on an empty project.
 */

const props = defineProps<{
  /** Shared timeline viewport (read-only here; the canvas owns resizing). */
  range: TimelineRange;
  /** Monotonic counter bumped by the container after view mutations. */
  revision: number;
  /** The project chord track, already sorted by startPpq. */
  chords: ReadonlyArray<EditorChordSymbol>;
  /** Time-signature map in the same PPQ frame as `chords`/`originPpq`. */
  timeSignatures: ReadonlyArray<MeterSegment>;
  /** MusicXML key-signature fifths used for root and slash-bass spelling. */
  keyFifths?: number;
  /** Absolute PPQ the lane's local frame is shifted by (default 0). */
  originPpq?: number;
  /** Whether any track carries audible content (arrangement only; drives the tracks-empty hint). */
  hasContent?: boolean;
  /** Renders the empty/tracks-empty hints; the arrangement host opts in, the piano roll does not. */
  showHints?: boolean;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
  /** Request to reveal the chord list editor. */
  openChords: [];
}>();

const { t } = useI18n();

/** Min px between repeated chord-name labels inside one long chord's band. */
const LABEL_MIN_SPACING_PX = DEFAULT_MIN_BAR_LABEL_SPACING_PX;
/** Skip a repeat label this close to the band's right edge (no room). */
const LABEL_TAIL_GUARD_PX = 24;
/** Skip the "tracks are still empty" hint this close to the lane's right edge. */
const TRACKS_HINT_MIN_GAP_PX = 200;
/** How long the first-populate brightness pulse lasts. */
const POPULATE_PULSE_MS = 1200;

/** One repeated chord-name label, positioned relative to its band's left edge. */
interface ChordLabel {
  key: number;
  offsetPx: number;
}

/** One positioned, culled chord band. */
interface ChordBand {
  key: number;
  name: string;
  startPpq: number;
  leftPx: number;
  widthPx: number;
  labels: ChordLabel[];
}

/** Bar-boundary label anchors within the band's visible span (sticky first anchor). */
function labelsFor(
  chord: EditorChordSymbol,
  origin: number,
  leftPx: number,
  rightPx: number,
): ChordLabel[] {
  const bandStart = chord.startPpq - origin;
  const bandEnd = chord.endPpq - origin;
  const visStart = Math.max(bandStart, props.range.startPpq);
  const visEnd = Math.min(bandEnd, props.range.endPpq);
  if (visStart >= visEnd) return [];
  const firstX = props.range.ppqToX(visStart);
  const labels: ChordLabel[] = [{ key: visStart, offsetPx: Math.max(0, firstX - leftPx) }];
  let lastEmittedX = firstX;
  let anchor = visStart;
  // Bar count in a viewport is small; the guard just prevents a runaway loop
  // if a degenerate meter map ever yields a non-advancing bar range.
  for (let guard = 0; guard < 4096; guard++) {
    const bar = barRangeAt(props.timeSignatures, anchor);
    const next = bar.startPpq + bar.lengthPpq;
    if (!(next < visEnd) || next <= anchor) break;
    anchor = next;
    const anchorX = props.range.ppqToX(anchor);
    if (anchorX - lastEmittedX < LABEL_MIN_SPACING_PX) continue;
    if (rightPx - anchorX < LABEL_TAIL_GUARD_PX) continue;
    labels.push({ key: anchor, offsetPx: anchorX - leftPx });
    lastEmittedX = anchorX;
  }
  return labels;
}

const bands = computed<ChordBand[]>(() => {
  void props.revision;
  const origin = props.originPpq ?? 0;
  const out: ChordBand[] = [];
  for (const chord of props.chords) {
    const x0 = props.range.ppqToX(chord.startPpq - origin);
    const x1 = props.range.ppqToX(chord.endPpq - origin);
    if (x1 <= 0 || x0 >= props.range.widthPx) continue;
    out.push({
      key: chord.startPpq,
      name: formatChordName(chord, props.keyFifths ?? 0),
      startPpq: chord.startPpq,
      leftPx: x0,
      widthPx: Math.max(2, x1 - x0),
      labels: labelsFor(chord, origin, x0, x1),
    });
  }
  return out;
});

/** Left edge for the "chords are a guide, tracks are still empty" hint. */
const tracksHintLeftPx = computed<number | null>(() => {
  void props.revision;
  if (!props.showHints || props.hasContent !== false || props.chords.length === 0) return null;
  const origin = props.originPpq ?? 0;
  const last = props.chords[props.chords.length - 1];
  const x1 = props.range.ppqToX(last.endPpq - origin);
  if (x1 > props.range.widthPx - TRACKS_HINT_MIN_GAP_PX) return null;
  return Math.max(0, x1 + 8);
});

function seekTo(band: ChordBand): void {
  emit('seek', Math.max(0, band.startPpq));
}

function seekTitle(band: ChordBand): string {
  return formatMessage(t.value.shell.arrangement.chordSeek, { name: band.name });
}

// First-populate pulse: draws the eye to the lane the moment a progression
// lands, without any toast/dialog infrastructure.
const justPopulated = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.chords.length,
  (count, previous) => {
    if (previous !== 0 || count === 0) return;
    justPopulated.value = true;
    if (pulseTimer !== null) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      justPopulated.value = false;
      pulseTimer = null;
    }, POPULATE_PULSE_MS);
  },
);

onBeforeUnmount(() => {
  if (pulseTimer !== null) clearTimeout(pulseTimer);
});
</script>

<template>
  <div
    class="chord-lane"
    role="group"
    :aria-label="t.shell.arrangement.chordLane"
    v-tooltip="t.shell.arrangement.openChordList"
    @dblclick="emit('openChords')"
  >
    <div
      v-for="band in bands"
      :key="band.key"
      class="chord-band"
      :class="{ 'chord-band-flash': justPopulated }"
      :style="{ left: `${band.leftPx}px`, width: `${band.widthPx}px` }"
      v-tooltip="seekTitle(band)"
      @click="seekTo(band)"
    >
      <span
        v-for="label in band.labels"
        :key="label.key"
        class="chord-name"
        :style="{ left: `${label.offsetPx}px` }"
      >
        {{ band.name }}
      </span>
    </div>
    <span v-if="props.showHints && props.chords.length === 0" class="chord-hint">
      {{ t.shell.arrangement.chordEmptyHint }}
    </span>
    <span
      v-else-if="tracksHintLeftPx !== null"
      class="chord-hint"
      :style="{ left: `${tracksHintLeftPx}px` }"
    >
      {{ t.shell.arrangement.chordTracksHint }}
    </span>
  </div>
</template>

<style scoped>
.chord-lane {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-strong);
}

.chord-band {
  position: absolute;
  top: 2px;
  bottom: 2px;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-3) 55%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  transition: filter var(--dur-1) var(--ease-out);
}

.chord-band:hover {
  filter: brightness(1.2);
}

.chord-band-flash {
  filter: brightness(1.5);
}

.chord-name {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 var(--sp-2);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.chord-hint {
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

<script setup lang="ts">
import { type KeyScale, type PivotChord, spelledKeyOf } from '@libraz/libcantus';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { matchModeChoiceId } from '@/components/lists/key-modes';
import { useNoteNames } from '@/composables/useNoteNames';
import {
  analyzeHarmony,
  type BorrowedKind,
  type CadenceType,
  type KeySpan,
} from '@/compose/harmonic-analysis';
import type { KeyMap } from '@/compose/key-map';
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
 *
 * The functional reading of the progression rides along as display-only
 * annotation: an applied-dominant numeral or a borrowing mark beside the chord
 * name, a rule where a cadence lands, and — only on a track that modulates — a
 * named band per key the track passes through, saying how the key moved and,
 * on hover, which chord the move turned on. The markers are inert
 * (`pointer-events: none`) apart from that one label, so seeking and the
 * chord-list shortcut behave the same with or without an analysis.
 *
 * The progression is read region by region of the project's key map, and
 * each chord's root and slash-bass are spelled with that region's own
 * key-signature fifths.
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
  /** The project's key map, in the same absolute PPQ frame as `chords`. */
  keyMap: KeyMap;
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
  /** Request to open the progression generator (empty-state action). */
  generate: [];
}>();

const { t } = useI18n();
const { formatNoteName, system: noteNameSystem } = useNoteNames();

/** Min px between repeated chord-name labels inside one long chord's band. */
const LABEL_MIN_SPACING_PX = DEFAULT_MIN_BAR_LABEL_SPACING_PX;
/** Skip a repeat label this close to the band's right edge (no room). */
const LABEL_TAIL_GUARD_PX = 24;
/** Skip the "tracks are still empty" hint this close to the lane's right edge. */
const TRACKS_HINT_MIN_GAP_PX = 200;
/** How long the first-populate brightness pulse lasts. */
const POPULATE_PULSE_MS = 1200;
/** Room the approaching band needs before a cadence gets a written label. */
const CADENCE_LABEL_MIN_ROOM_PX = 40;
/** Room a key span needs on screen before its name is written into it. */
const KEY_LABEL_MIN_ROOM_PX = 40;

/**
 * Conventional shorthand per borrowing source: borrowing from the parallel
 * minor lowers degrees, borrowing from the parallel major restores them, and N
 * is the standard Neapolitan symbol. The band tooltip names the source in full.
 */
const BORROWED_MARK: Readonly<Record<BorrowedKind, string>> = {
  parallelMinor: '♭',
  parallelMajor: '♮',
  neapolitan: 'N',
};

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
  /** Applied numeral and/or borrowing mark drawn beside the name; '' for none. */
  mark: string;
}

/** One positioned, culled key-span band. */
interface KeySpanBand {
  key: number;
  /** Key name as it is written into the band, e.g. "Eb Major (Ionian)". */
  name: string;
  leftPx: number;
  widthPx: number;
  /** Whether the visible span is wide enough for the written name. */
  showLabel: boolean;
  /** How the key moved to get here, e.g. "to the dominant"; '' on the first span. */
  move: string;
  /** The move in words, with the chord it turned on and the ones it could have. */
  moveTitle: string;
}

/** One positioned, culled cadence marker. */
interface CadenceMarker {
  key: number;
  type: CadenceType;
  leftPx: number;
  /** Whether the approaching band is wide enough for the written abbreviation. */
  showLabel: boolean;
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

/** Display-only functional reading of the whole chord track. */
const analysis = computed(() => analyzeHarmony(props.chords, props.keyMap));

/** Cadence type by the absolute PPQ of the chord it resolves onto. */
const cadenceByPpq = computed(
  () => new Map(analysis.value.cadences.map((cadence) => [cadence.atPpq, cadence.type])),
);

/** Applied numeral and borrowing mark of one chord, as one short string. */
function markFor(startPpq: number): string {
  const annotation = analysis.value.byStartPpq.get(startPpq);
  if (annotation === undefined) return '';
  const parts: string[] = [];
  if (annotation.appliedRoman !== undefined) parts.push(annotation.appliedRoman);
  if (annotation.borrowed !== undefined) parts.push(BORROWED_MARK[annotation.borrowed]);
  return parts.join(' ');
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
      name: formatChordName(chord, props.keyMap.keyFifthsAt(chord.startPpq), noteNameSystem.value),
      startPpq: chord.startPpq,
      leftPx: x0,
      widthPx: Math.max(2, x1 - x0),
      labels: labelsFor(chord, origin, x0, x1),
      mark: markFor(chord.startPpq),
    });
  }
  return out;
});

/**
 * Name of a key as the band writes it: the tonic spelled the way the key's own
 * signature writes it (so a flat key reads Eb, not D#), plus the mode named in
 * the vocabulary the key editor already uses.
 */
function keyName(key: KeyScale): string {
  const labels = t.value.shell.lists.key;
  const modes: Readonly<Record<string, string>> = labels.modes;
  const modeId = matchModeChoiceId(key.modeMask12);
  const mode = (modeId === null ? undefined : modes[modeId]) ?? labels.customScale;
  return `${formatNoteName(spelledKeyOf(key).tonic)} ${mode}`;
}

/**
 * How the key moved into this span, in a few words, or '' for the opening span
 * and for a span the detection places without naming a relation between the two
 * keys. A move with no name still shows in the tooltip, since the key band
 * itself is already saying that the key changed.
 */
function moveLabel(span: KeySpan): string {
  if (span.modulation === undefined) return '';
  return t.value.harmony.modulation.relation[span.modulation];
}

/**
 * The move in words: which relation it is, the chord it turned on, and the
 * other chords that read in both keys. A modulation between keys that share no
 * chord says so, because "direct" is a reading and not a missing answer.
 */
function moveTitle(span: KeySpan): string {
  if (span.sharedChords === undefined) return '';
  const strings = t.value.harmony.modulation;
  const relation =
    span.modulation === undefined ? strings.unnamedRelation : strings.relation[span.modulation];
  const parts = [`${strings.label} ${relation}`];
  const roman = (pivot: PivotChord): string => `${pivot.romanFrom} = ${pivot.romanTo}`;
  if (span.pivot !== undefined) {
    parts.push(formatMessage(strings.pivot, { roman: roman(span.pivot) }));
  } else if (span.sharedChords.length === 0) {
    parts.push(strings.direct);
  }
  const others = span.sharedChords.filter(
    (candidate) => span.pivot === undefined || roman(candidate) !== roman(span.pivot),
  );
  if (others.length > 0) {
    parts.push(formatMessage(strings.alternatives, { romans: others.map(roman).join(', ') }));
  }
  return parts.join(' ');
}

const keySpanBands = computed<KeySpanBand[]>(() => {
  void props.revision;
  const origin = props.originPpq ?? 0;
  const out: KeySpanBand[] = [];
  for (const span of analysis.value.keySpans) {
    const x0 = props.range.ppqToX(span.startPpq - origin);
    const x1 = props.range.ppqToX(span.endPpq - origin);
    if (x1 <= 0 || x0 >= props.range.widthPx) continue;
    const visibleWidthPx = Math.min(x1, props.range.widthPx) - Math.max(x0, 0);
    out.push({
      key: span.startPpq,
      name: keyName(span.key),
      leftPx: x0,
      widthPx: Math.max(2, x1 - x0),
      showLabel: visibleWidthPx >= KEY_LABEL_MIN_ROOM_PX,
      move: moveLabel(span),
      moveTitle: moveTitle(span),
    });
  }
  return out;
});

const cadenceMarkers = computed<CadenceMarker[]>(() => {
  void props.revision;
  const origin = props.originPpq ?? 0;
  const starts = props.chords.map((chord) => chord.startPpq);
  const out: CadenceMarker[] = [];
  // Cadences and chords are both in time order, so the band a cadence is
  // approached from is found by advancing one shared cursor.
  let index = 0;
  for (const cadence of analysis.value.cadences) {
    while (index + 1 < starts.length && starts[index + 1] < cadence.atPpq) index += 1;
    const x = props.range.ppqToX(cadence.atPpq - origin);
    if (x < 0 || x > props.range.widthPx) continue;
    // The abbreviation is written into the tail of the approaching band, so it
    // only appears where that band still has visible room for it.
    const approach = starts.length > 0 && starts[index] < cadence.atPpq ? starts[index] : null;
    const roomPx = approach === null ? x : x - Math.max(0, props.range.ppqToX(approach - origin));
    out.push({
      key: cadence.atPpq,
      type: cadence.type,
      leftPx: x,
      showLabel: roomPx >= CADENCE_LABEL_MIN_ROOM_PX,
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

/** Localized abbreviation written next to a cadence rule. */
function cadenceShort(type: CadenceType): string {
  return t.value.harmony.cadence.short[type];
}

/**
 * Band tooltip: the seek hint, plus the functional reading in words, since the
 * markers themselves stay inert and abbreviated.
 */
function seekTitle(band: ChordBand): string {
  const base = formatMessage(t.value.shell.arrangement.chordSeek, { name: band.name });
  const harmony = t.value.harmony;
  const annotation = analysis.value.byStartPpq.get(band.startPpq);
  const cadence = cadenceByPpq.value.get(band.startPpq);
  const parts: string[] = [];
  if (annotation?.appliedRoman !== undefined) {
    parts.push(formatMessage(harmony.applied.label, { roman: annotation.appliedRoman }));
  }
  if (annotation?.borrowed !== undefined) parts.push(harmony.borrowed[annotation.borrowed]);
  if (cadence !== undefined) parts.push(harmony.cadence[cadence]);
  return parts.length === 0 ? base : `${base} · ${parts.join(' · ')}`;
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
        <span v-if="band.mark !== ''" class="chord-mark">{{ band.mark }}</span>
      </span>
    </div>
    <div
      v-for="span in keySpanBands"
      :key="span.key"
      class="key-span"
      :style="{ left: `${span.leftPx}px`, width: `${span.widthPx}px` }"
    >
      <span
        v-if="span.showLabel"
        class="key-span-label"
        :class="{ 'key-span-moved': span.moveTitle !== '' }"
        v-tooltip="span.moveTitle"
      >
        {{ span.name }}<span v-if="span.move !== ''" class="key-span-move"> · {{ span.move }}</span>
      </span>
    </div>
    <div
      v-for="marker in cadenceMarkers"
      :key="marker.key"
      class="cadence-mark"
      :style="{ left: `${marker.leftPx}px` }"
    >
      <span v-if="marker.showLabel" class="cadence-label">{{ cadenceShort(marker.type) }}</span>
    </div>
    <span v-if="props.showHints && props.chords.length === 0" class="chord-hint">
      {{ t.shell.arrangement.chordEmptyHint }}
      <button
        type="button"
        class="chord-hint-action"
        v-tooltip="t.shell.arrangement.generateChordsTitle"
        @click.stop="emit('generate')"
        @dblclick.stop
      >
        {{ t.shell.arrangement.chordEmptyAction }}
      </button>
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

.chord-mark {
  margin-left: var(--sp-1);
  font: var(--fw-medium) var(--fs-2xs) var(--font-sans);
  color: var(--text-3);
  white-space: nowrap;
}

/*
 * The band tints the span it covers and rules its left edge, where the key
 * changes; the name is written into the span's tail, the strip the chord-name
 * tiler already keeps clear (see LABEL_TAIL_GUARD_PX).
 */
/* The band is rounded, so the accent is carried by a full hairline and a tint
 * rather than a straight edge marker that would cut across the corner. */
.key-span {
  position: absolute;
  top: 2px;
  bottom: 2px;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  overflow: hidden;
  pointer-events: none;
}

.key-span-label {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--sp-2);
  display: flex;
  align-items: center;
  font: var(--fw-medium) var(--fs-2xs) var(--font-sans);
  color: var(--accent);
  white-space: nowrap;
}

/* Only a band that has a modulation to explain takes the pointer back from the
 * lane, so the chord bands underneath stay clickable everywhere else. */
.key-span-moved {
  pointer-events: auto;
  cursor: help;
}

.key-span-move {
  color: var(--text-3);
}

.cadence-mark {
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  margin-left: -1px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 65%, transparent);
  pointer-events: none;
}

.cadence-label {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--sp-2);
  display: flex;
  align-items: center;
  font: var(--fw-medium) var(--fs-2xs) var(--font-sans);
  color: var(--accent);
  white-space: nowrap;
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

.chord-hint-action {
  margin-left: var(--sp-2);
  padding: 1px var(--sp-3);
  font: var(--fw-medium) var(--fs-2xs) var(--font-sans);
  color: var(--accent);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: var(--radius-md);
  box-shadow: none;
  cursor: pointer;
  pointer-events: auto;
}

.chord-hint-action:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.chord-hint-action:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>

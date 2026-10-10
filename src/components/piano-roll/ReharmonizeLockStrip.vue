<script setup lang="ts">
import { computed } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import type { LockedRegion } from '@/compose/reharmonize-reactive';
import { isRegionLocked } from '@/compose/reharmonize-session';
import type { EditorChordSymbol } from '@/project/chords';
import { formatChordName } from '@/project/chords';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Slim strip over the top of the note grid showing the chord track's regions
 * as clickable segments: a click toggles a session lock on that chord's span,
 * and locked spans render with an accent fill plus a padlock so pinned
 * harmony is visible while editing. Purely presentational — the lock set is
 * owned by the reharmonization session in the host.
 */

const props = defineProps<{
  /** Shared timeline mapping (clip-source frame, like the note grid). */
  range: TimelineRange;
  /** Pan/zoom revision counter; bumping it recomputes segment positions. */
  revision: number;
  /** The project chord track, in absolute PPQ. */
  chords: ReadonlyArray<EditorChordSymbol>;
  /** Absolute PPQ of the active clip's start (chord-to-grid frame shift). */
  originPpq: number;
  /** MusicXML key-signature fifths used for chord-name spelling. */
  keyFifths?: number;
  /** Session-locked progression spans, in absolute PPQ. */
  locks: ReadonlyArray<LockedRegion>;
}>();

const emit = defineEmits<{
  /** Toggle a lock over one chord's region (absolute PPQ). */
  toggle: [region: LockedRegion];
}>();

const { t } = useI18n();
const { system: noteNameSystem } = useNoteNames();

/** Narrower than this on screen a segment is unclickable noise; skip it. */
const MIN_SEGMENT_PX = 8;

interface StripSegment {
  key: number;
  name: string;
  region: LockedRegion;
  locked: boolean;
  leftPx: number;
  widthPx: number;
}

const segments = computed<StripSegment[]>(() => {
  // Positions depend on pan/zoom, which the range reports via the revision.
  void props.revision;
  const out: StripSegment[] = [];
  const viewWidth = props.range.widthPx;
  for (const chord of props.chords) {
    const x0 = props.range.ppqToX(chord.startPpq - props.originPpq);
    const x1 = props.range.ppqToX(chord.endPpq - props.originPpq);
    const leftPx = Math.max(0, x0);
    const widthPx = Math.min(viewWidth, x1) - leftPx;
    if (widthPx < MIN_SEGMENT_PX) continue;
    const region: LockedRegion = { startPpq: chord.startPpq, endPpq: chord.endPpq };
    out.push({
      key: chord.startPpq,
      name: formatChordName(chord, props.keyFifths ?? 0, noteNameSystem.value),
      region,
      locked: isRegionLocked(props.locks, region),
      leftPx,
      widthPx,
    });
  }
  return out;
});

function segmentTitle(segment: StripSegment): string {
  return formatMessage(
    segment.locked
      ? t.value.shell.pianoRoll.reharmonize.unlock
      : t.value.shell.pianoRoll.reharmonize.lock,
    { name: segment.name },
  );
}
</script>

<template>
  <div class="lock-strip" role="group" :aria-label="t.shell.pianoRoll.reharmonize.lockStrip">
    <button
      v-for="segment in segments"
      :key="segment.key"
      type="button"
      class="lock-segment"
      :class="{ 'lock-segment-locked': segment.locked }"
      :style="{ left: `${segment.leftPx}px`, width: `${segment.widthPx}px` }"
      :aria-pressed="segment.locked"
      v-tooltip="segmentTitle(segment)"
      @click="emit('toggle', segment.region)"
    >
      <svg
        v-if="segment.locked"
        class="lock-glyph"
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        <rect x="2" y="4.5" width="6" height="4.5" rx="1" fill="currentColor" />
        <path
          d="M3.4 4.5V3.2a1.6 1.6 0 0 1 3.2 0v1.3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.1"
        />
      </svg>
      <span class="lock-name">{{ segment.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.lock-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 18px;
  z-index: 10;
  overflow: hidden;
  /* Only the segments take pointer input; the grid stays fully editable in
   * the gaps and past the last chord. */
  pointer-events: none;
  /* Opacity only: segments are column-aligned with the note grid. */
  animation: fade-once var(--dur-2) var(--ease-out);
}

.lock-segment {
  position: absolute;
  top: 2px;
  bottom: 2px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0 0.3rem;
  border: none;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-3) 55%, transparent);
  box-shadow: none;
  color: var(--text-4);
  font: var(--fw-semibold) var(--fs-2xs)/1 var(--font-sans);
  letter-spacing: 0.03em;
  overflow: hidden;
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.lock-segment:hover {
  background: var(--surface-3);
  color: var(--text-2);
}

/* Accent tint marks pinned harmony without adding a perimeter stroke. */
.lock-segment-locked,
.lock-segment-locked:hover {
  background: var(--accent-soft);
  box-shadow: none;
  color: var(--text-1);
}

.lock-segment:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.lock-glyph {
  flex: none;
  width: 9px;
  height: 9px;
  animation: pop-in var(--dur-2) var(--ease-spring);
}

.lock-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

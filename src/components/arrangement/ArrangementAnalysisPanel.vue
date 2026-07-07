<script setup lang="ts">
import { formatNote, midiToNote, NoteSafety } from '@libraz/libcantus';
import { computed, ref } from 'vue';
import { formatBarBeat } from '@/components/lists/bar-beat';
import { useArrangementAnalysis } from '@/composables/useArrangementAnalysis';
import type { ArrangementConflict } from '@/compose/arrangement';
import { setActiveClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/**
 * Collapsible cross-track analysis panel for the arrangement view: an
 * on-demand conflict list (notes clashing with the sounding harmony), the
 * percussion tracks excluded from analysis, and a compact tension sparkline.
 *
 * The analysis sweeps every track, so it is expensive; it runs only from the
 * Analyze button — never as a live watcher — and the button is disabled while
 * the transport is playing. Clicking a conflict row activates the clip under
 * the conflict (best effort) and asks the host to move the playhead there.
 */

const props = defineProps<{
  /** True while the transport is playing; disables Analyze during playback. */
  isPlaying?: boolean;
}>();

const emit = defineEmits<{
  /** Request to move the playhead to a conflict's absolute PPQ position. */
  jump: [ppq: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const { conflicts, tension, excludedTrackNames, analyzed, analyze } = useArrangementAnalysis();

/** Disclosure state; the panel starts collapsed. */
const expanded = ref(false);

function runAnalysis(): void {
  if (props.isPlaying) return;
  analyze();
}

/** Sparkline viewBox width in local units. */
const SPARK_WIDTH = 120;
/** Sparkline viewBox height in local units. */
const SPARK_HEIGHT = 20;
/** Vertical inset keeping the stroke inside the viewBox at tension 0 and 1. */
const SPARK_PAD = 1;

/** Polyline points for the tension sparkline (x = sample index, y = tension). */
const sparklinePoints = computed<string>(() => {
  const samples = tension.value;
  if (samples.length === 0) return '';
  const y = (value: number): string =>
    (SPARK_PAD + (1 - value) * (SPARK_HEIGHT - 2 * SPARK_PAD)).toFixed(2);
  if (samples.length === 1) {
    return `0,${y(samples[0].tension)} ${SPARK_WIDTH},${y(samples[0].tension)}`;
  }
  return samples
    .map(
      (sample, index) =>
        `${((index / (samples.length - 1)) * SPARK_WIDTH).toFixed(2)},${y(sample.tension)}`,
    )
    .join(' ');
});

/** Bar.beat display position of a conflict. */
function positionLabel(ppq: number): string {
  return formatBarBeat(ppq, store.timeSignatures);
}

/** Spelled note name (e.g. "C#4") of a conflict's MIDI pitch. */
function pitchLabel(pitch: number): string {
  return formatNote(midiToNote(pitch));
}

/** Localized severity text for a conflict's safety verdict. */
function severityLabel(conflict: ArrangementConflict): string {
  return conflict.safety === NoteSafety.Dissonant
    ? t.value.shell.arrangementAnalysis.dissonant
    : t.value.shell.arrangementAnalysis.warning;
}

/**
 * Best-effort jump to a conflict: activates the clip covering the conflict on
 * its track when one resolves, and always asks the host to move the playhead.
 */
function jumpTo(conflict: ArrangementConflict): void {
  const track = store.tracks.find((entry) => entry.name === conflict.trackName);
  if (track) {
    const clip = (store.clipsByTrack.get(track.id) ?? []).find(
      (entry) => conflict.ppq >= entry.startPpq && conflict.ppq < entry.startPpq + entry.lengthPpq,
    );
    if (clip) setActiveClip(clip.id);
  }
  emit('jump', conflict.ppq);
}
</script>

<template>
  <section class="analysis-panel">
    <header class="ap-head">
      <button
        type="button"
        class="ap-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <svg class="ap-chevron" :class="{ 'is-open': expanded }" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
          <path d="M2 1l4 3-4 3z" fill="currentColor" />
        </svg>
        {{ t.shell.arrangementAnalysis.title }}
      </button>
      <button
        v-if="expanded"
        type="button"
        class="ap-analyze"
        :disabled="props.isPlaying"
        @click="runAnalysis"
      >
        {{ t.shell.arrangementAnalysis.analyze }}
      </button>
    </header>

    <div v-if="expanded" class="ap-body">
      <p v-if="!analyzed" class="ap-prompt">{{ t.shell.arrangementAnalysis.runPrompt }}</p>
      <template v-else>
        <p v-if="excludedTrackNames.length > 0" class="ap-excluded">
          {{ t.shell.arrangementAnalysis.excluded }}: {{ excludedTrackNames.join(', ') }}
        </p>

        <div v-if="sparklinePoints !== ''" class="ap-tension">
          <span class="ap-tension-label">{{ t.shell.arrangementAnalysis.tension }}</span>
          <svg
            class="ap-spark"
            :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline :points="sparklinePoints" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
        </div>

        <p v-if="conflicts.length === 0" class="ap-clear">
          {{ t.shell.arrangementAnalysis.noConflicts }}
        </p>
        <ul v-else class="ap-conflicts">
          <li v-for="(conflict, index) in conflicts" :key="index">
            <button type="button" class="ap-row" @click="jumpTo(conflict)">
              <span
                class="ap-dot"
                :class="conflict.safety === NoteSafety.Dissonant ? 'is-dissonant' : 'is-warning'"
                :title="severityLabel(conflict)"
                :aria-label="severityLabel(conflict)"
              />
              <span class="ap-pos">{{ positionLabel(conflict.ppq) }}</span>
              <span class="ap-track">{{ conflict.trackName }}</span>
              <span class="ap-pitch">{{ pitchLabel(conflict.pitch) }}</span>
              <span v-if="conflict.rationale" class="ap-rationale">{{ conflict.rationale }}</span>
            </button>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>

<style scoped>
.analysis-panel {
  flex: 0 0 auto;
  background: var(--surface-1);
  border-top: 1px solid var(--border-strong);
  color: var(--text-2);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.ap-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-4);
}

.ap-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  font: var(--fw-semibold) 9px var(--font-sans);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-4);
  background: none;
  border: none;
  cursor: pointer;
}

.ap-toggle:hover {
  color: var(--text-3);
}

.ap-chevron {
  transition: transform var(--dur-1) var(--ease-out);
}

.ap-chevron.is-open {
  transform: rotate(90deg);
}

.ap-analyze {
  margin-left: auto;
  padding: 1px var(--sp-2);
  font: var(--fw-semibold) 9px var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-2);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  box-shadow: var(--control-lift);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
}

.ap-analyze:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.ap-analyze:focus-visible {
  box-shadow: var(--control-lift), var(--ring);
}

.ap-analyze:disabled {
  opacity: 0.4;
  cursor: default;
}

.ap-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 10rem;
  overflow-y: auto;
  padding: 0 var(--sp-4) var(--sp-3);
}

.ap-prompt,
.ap-clear,
.ap-excluded {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ap-excluded {
  color: var(--text-4);
}

.ap-tension {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.ap-tension-label {
  font-size: var(--fs-2xs);
  color: var(--text-4);
}

.ap-spark {
  width: 8rem;
  height: 20px;
  color: var(--text-4);
  background: var(--surface-inset);
  border-radius: var(--radius-xs);
}

.ap-conflicts {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ap-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  font: var(--fs-xs)/1.4 var(--font-sans);
  text-align: left;
  color: var(--text-2);
  background: none;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
}

.ap-row:hover {
  background: var(--surface-4);
}

.ap-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.ap-dot.is-warning {
  background: var(--warning);
  opacity: 0.5;
}

.ap-dot.is-dissonant {
  background: var(--danger);
  opacity: 0.5;
}

.ap-pos {
  flex: none;
  min-width: 2.5rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.ap-track {
  flex: none;
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ap-pitch {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.ap-rationale {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-4);
}
</style>

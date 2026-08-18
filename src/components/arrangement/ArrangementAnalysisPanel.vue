<script setup lang="ts">
import { NoteSafety } from '@libraz/libcantus';
import { computed, onBeforeUnmount, ref } from 'vue';
import { formatBarBeat } from '@/components/lists/bar-beat';
import { useArrangementAnalysis } from '@/composables/useArrangementAnalysis';
import { useNoteNames } from '@/composables/useNoteNames';
import type { ArrangementConflict } from '@/compose/arrangement';
import type { TrackMotifs } from '@/compose/motifs';
import type { RankedCadence } from '@/compose/phrases';
import { setActiveClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/**
 * Cross-track analysis header for the arrangement view: a slim, always-visible
 * bar with an on-demand Analyze action. Results (a conflict list of notes
 * clashing with the sounding harmony, the percussion tracks excluded from
 * analysis, and a compact tension sparkline) open in a floating popover below
 * the bar, so the header never grows and never pushes the arrangement's track
 * lanes out of view.
 *
 * The same run also reads the piece's structure — where it breathes into
 * phrases, which cadences carry the most weight, and how the bars group above
 * the bar line. That is shown as a summary line plus a ranked cadence list,
 * because a phrase list of its own would repeat what the cadences already say.
 *
 * The analysis sweeps every track, so it is expensive; it runs only from the
 * Analyze button — never as a live watcher — and the button is disabled while
 * the transport is playing. Clicking a conflict or a cadence activates the clip
 * under it (best effort) and asks the host to move the playhead there; the
 * popover stays open so several can be visited in sequence.
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
const { formatPitch } = useNoteNames();
const {
  conflicts,
  tension,
  phrases,
  cadences,
  hypermeter,
  motifs,
  excludedTrackNames,
  analyzed,
  analyze,
} = useArrangementAnalysis();

/** Popover open state; the header bar itself never resizes. */
const open = ref(false);
/** Popover position, computed from the header bar when it opens. */
const popoverStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });
const headerEl = ref<HTMLElement | null>(null);

/** Closes the popover on any press outside of it or the header bar. */
function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('.ap-popover') && !target?.closest('.ap-head')) closePopover();
}

function openPopover(): void {
  const rect = headerEl.value?.getBoundingClientRect();
  if (rect) popoverStyle.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
  open.value = true;
  window.addEventListener('pointerdown', onOutsidePointerDown, true);
}

function closePopover(): void {
  if (!open.value) return;
  open.value = false;
  window.removeEventListener('pointerdown', onOutsidePointerDown, true);
}

function toggleResults(): void {
  if (open.value) closePopover();
  else openPopover();
}

function runAnalysis(): void {
  if (props.isPlaying) return;
  openPopover();
  analyze();
}

onBeforeUnmount(closePopover);

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
  // A conflict pitch always comes from note data in the MIDI range; falling
  // back to the raw number keeps a malformed one from throwing mid-render.
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return String(pitch);
  return formatPitch(pitch);
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

/** One-line reading of the structure: phrase count and how bars group. */
const structureSummary = computed<string>(() => {
  const grouping = hypermeter.value;
  if (phrases.value.length === 0 || grouping === null) return '';
  const strings = t.value.shell.arrangementAnalysis;
  return `${strings.phraseCount.replace('{count}', String(phrases.value.length))} / ${strings.hyperbar.replace('{bars}', String(grouping.groupBars))}`;
});

/**
 * Localized name of a cadence type, taken from the shared harmony vocabulary so
 * a cadence reads the same here as it does on the chord lane.
 */
function cadenceLabel(type: RankedCadence['type']): string {
  return t.value.harmony.cadence[type];
}

/** Cadence weight as a whole-percent string, so the ranking is legible. */
function weightLabel(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

/** How often a figure is stated, and how long it is. */
function motifLabel(motif: TrackMotifs['motifs'][number]): string {
  const strings = t.value.shell.arrangementAnalysis;
  const times = strings.motifStatements.replace('{count}', String(motif.statements.length));
  return `${times} / ${strings.motifNotes.replace('{count}', String(motif.noteCount))}`;
}
</script>

<template>
  <section class="analysis-panel">
    <header ref="headerEl" class="ap-head">
      <button
        type="button"
        class="ap-toggle"
        :aria-expanded="open"
        @click="toggleResults"
      >
        <svg class="ap-chevron" :class="{ 'is-open': open }" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
          <path d="M2 1l4 3-4 3z" fill="currentColor" />
        </svg>
        {{ t.shell.arrangementAnalysis.title }}
      </button>
      <button
        type="button"
        class="ap-analyze"
        :disabled="props.isPlaying"
        @click="runAnalysis"
      >
        {{ t.shell.arrangementAnalysis.analyze }}
      </button>
    </header>

    <Transition name="pop">
      <div v-if="open" class="ap-popover" :style="popoverStyle" role="dialog" :aria-label="t.shell.arrangementAnalysis.title">
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

          <p v-if="structureSummary !== ''" class="ap-structure">{{ structureSummary }}</p>

          <ul v-if="cadences.length > 0" class="ap-cadences">
            <li v-for="cadence in cadences" :key="cadence.phraseIndex">
              <button type="button" class="ap-cadence-row" @click="emit('jump', cadence.atPpq)">
                <span class="ap-pos">{{ positionLabel(cadence.atPpq) }}</span>
                <span class="ap-cadence-type">{{ cadenceLabel(cadence.type) }}</span>
                <span class="ap-weight">{{ weightLabel(cadence.weight) }}</span>
                <span class="ap-rationale">{{ cadence.rationale }}</span>
              </button>
            </li>
          </ul>

          <ul v-if="motifs.length > 0" class="ap-motifs">
            <li v-for="entry in motifs" :key="entry.trackName">
              <p class="ap-motif-track">
                {{ t.shell.arrangementAnalysis.motifs }}: {{ entry.trackName }}
              </p>
              <ul class="ap-motif-list">
                <li v-for="(motif, index) in entry.motifs" :key="index">
                  <button
                    type="button"
                    class="ap-motif-row"
                    @click="emit('jump', motif.statements[0].startPpq)"
                  >
                    <span class="ap-pos">{{ positionLabel(motif.statements[0].startPpq) }}</span>
                    <span class="ap-motif-count">{{ motifLabel(motif) }}</span>
                    <span class="ap-rationale">{{ motif.rationale }}</span>
                  </button>
                </li>
              </ul>
              <p v-for="(relation, index) in entry.relations" :key="`r${index}`" class="ap-relation">
                {{ relation.rationale }}
              </p>
            </li>
          </ul>

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
    </Transition>
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
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
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
  padding: var(--sp-1) var(--sp-3);
  font: var(--fw-semibold) var(--fs-xs) var(--font-sans);
  letter-spacing: 0.02em;
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

.ap-popover {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 26rem;
  max-width: calc(100vw - 2 * var(--sp-4));
  max-height: min(20rem, calc(100vh - 2 * var(--sp-4)));
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-hairline), var(--shadow-pop);
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

.ap-structure {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ap-conflicts,
.ap-cadences {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ap-cadence-row {
  display: grid;
  grid-template-columns: 2.75rem 5.5rem 2.5rem 1fr;
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

.ap-cadence-row:hover {
  background: var(--surface-4);
}

/* Figures a part restates: one group per track, each row jumping to the first
 * statement, with the named transformations between them beneath. */
.ap-motifs {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ap-motif-track {
  margin: 0 0 var(--sp-1);
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.ap-motif-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ap-motif-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  background: none;
  border: 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
  text-align: left;
  cursor: pointer;
}

.ap-motif-row:hover {
  background: var(--surface-inset);
  color: var(--text-1);
}

.ap-motif-count {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.ap-relation {
  margin: 0;
  padding: 0 var(--sp-2);
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.ap-weight {
  font-variant-numeric: tabular-nums;
  color: var(--text-4);
}

.ap-row {
  display: grid;
  grid-template-columns: 6px 2.75rem 7rem 3rem 1fr;
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
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.ap-dot.is-warning {
  background: var(--warning);
}

.ap-dot.is-dissonant {
  background: var(--danger);
}

.ap-pos {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.ap-track {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ap-pitch {
  font-variant-numeric: tabular-nums;
}

.ap-rationale {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-4);
}
</style>

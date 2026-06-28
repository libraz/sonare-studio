<script setup lang="ts">
import { setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import MidiFxPanel from './MidiFxPanel.vue';
import { ZOOM_BUTTON_STEP } from './use-piano-roll-zoom';

/**
 * Toolbar above the piano-roll grid: the multi-track ghost overlay toggle, a
 * track-color legend that focuses a track on click, the horizontal/vertical
 * zoom buttons and the MIDI-FX transform popover toggle. The overlay flag and
 * the transform popover open state are two-way bound to the editor; the legend
 * reads the project store directly.
 */

const overlayEnabled = defineModel<boolean>('overlayEnabled', { required: true });
const fxPanelOpen = defineModel<boolean>('fxPanelOpen', { required: true });

const props = defineProps<{
  /** True when a MIDI clip is active and can receive a transform. */
  canTransform: boolean;
  /** Active clip id passed to the transform popover. */
  clipId: number;
}>();

const emit = defineEmits<{
  /** Zoom the timeline horizontally by the given factor. */
  zoomHorizontal: [factor: number];
  /** Zoom the pitch rows vertically by the given factor. */
  zoomVertical: [factor: number];
}>();

const store = useProjectStore();
const { t } = useI18n();

/** Toggles the transform popover (closing it when no MIDI clip is active). */
function toggleFxPanel(): void {
  if (!props.canTransform) return;
  fxPanelOpen.value = !fxPanelOpen.value;
}

/** Legend chip click: focuses the track (activates its first clip, if any). */
function onLegendClick(trackId: number): void {
  // Re-clicking the active track keeps the currently active clip.
  if (trackId === store.activeTrackId) return;
  setActiveTrack(trackId);
}
</script>

<template>
  <div class="roll-toolbar">
    <label class="overlay-toggle">
      <input v-model="overlayEnabled" type="checkbox" />
      {{ t.shell.pianoRoll.overlay }}
    </label>
    <div class="track-legend">
      <button
        v-for="track in store.tracks"
        :key="track.id"
        type="button"
        class="legend-chip"
        :class="{ 'legend-chip-active': track.id === store.activeTrackId }"
        :title="track.name"
        @click="onLegendClick(track.id)"
      >
        <span class="chip-swatch" :style="{ background: track.color }" />
        <span class="chip-name">{{ track.name }}</span>
      </button>
    </div>
    <div class="zoom-cluster" role="group" :aria-label="t.shell.pianoRoll.zoom">
      <span class="zoom-pair">
        <button
          type="button"
          class="zoom-btn"
          :title="t.shell.pianoRoll.zoomOutTimeTitle"
          :aria-label="t.shell.pianoRoll.zoomOutHorizontal"
          @click="emit('zoomHorizontal', 1 / ZOOM_BUTTON_STEP)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M2 8h12M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M5.5 2.5h5" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" />
          </svg>
        </button>
        <button
          type="button"
          class="zoom-btn"
          :title="t.shell.pianoRoll.zoomInTimeTitle"
          :aria-label="t.shell.pianoRoll.zoomInHorizontal"
          @click="emit('zoomHorizontal', ZOOM_BUTTON_STEP)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M2 8h12M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M8 0v5M5.5 2.5h5" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" />
          </svg>
        </button>
      </span>
      <span class="zoom-pair">
        <button
          type="button"
          class="zoom-btn"
          :title="t.shell.pianoRoll.zoomOutPitchTitle"
          :aria-label="t.shell.pianoRoll.zoomOutVertical"
          @click="emit('zoomVertical', 1 / ZOOM_BUTTON_STEP)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M8 2v12M8 2L5.5 4.5M8 2l2.5 2.5M8 14l-2.5-2.5M8 14l2.5-2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M11 8h3.5" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" />
          </svg>
        </button>
        <button
          type="button"
          class="zoom-btn"
          :title="t.shell.pianoRoll.zoomInPitchTitle"
          :aria-label="t.shell.pianoRoll.zoomInVertical"
          @click="emit('zoomVertical', ZOOM_BUTTON_STEP)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M8 2v12M8 2L5.5 4.5M8 2l2.5 2.5M8 14l-2.5-2.5M8 14l2.5-2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M12.75 6.25v3.5M11 8h3.5" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" />
          </svg>
        </button>
      </span>
    </div>
    <button
      type="button"
      class="fx-toggle"
      :class="{ 'fx-toggle-active': fxPanelOpen }"
      :disabled="!canTransform"
      :aria-expanded="fxPanelOpen"
      :title="t.shell.pianoRoll.midiFxTitle"
      @click="toggleFxPanel"
    >
      {{ t.shell.pianoRoll.midiFx }}
    </button>
    <MidiFxPanel
      v-if="fxPanelOpen && canTransform"
      :clip-id="clipId"
      @close="fxPanelOpen = false"
    />
  </div>
</template>

<style scoped>
.roll-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0.5rem;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.zoom-cluster {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.zoom-pair {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Inherits the controls.css raised-face baseline (hover/active/press); only the
 * compact metrics and surface tint differ from the canonical button. */
.zoom-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 1.6rem;
  padding: 0.1rem 0.3rem;
  font: var(--fw-semibold) var(--fs-xs) var(--font-sans);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
}

.zoom-btn:hover:not(:disabled),
.fx-toggle:hover:not(:disabled) {
  color: var(--text-1);
}

.fx-toggle {
  flex: 0 0 auto;
  padding: 0.15rem 0.6rem;
  font: var(--fs-xs)/1.4 var(--font-sans);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.02em;
  background: var(--surface-3);
  border-radius: var(--radius-sm);
}

.fx-toggle-active {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--raise-hi), var(--shadow-1);
}

.fx-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.overlay-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
  cursor: pointer;
  color: var(--text-3);
}

.track-legend {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  overflow-x: auto;
}

.legend-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.45rem;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-out);
}

.legend-chip:hover {
  background: var(--surface-3);
}

.legend-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* Pair the accent tint with a thin inner ring so the active chip is
 * unambiguous against a merely hovered one. */
.legend-chip-active {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-muted);
  color: var(--text-1);
}

.legend-chip-active:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent-muted), var(--ring);
}

.chip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}

/* Redundant non-color cue for the active track beyond the accent tint. */
.legend-chip-active .chip-swatch {
  box-shadow: 0 0 0 2px var(--accent-muted);
}

.chip-name {
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

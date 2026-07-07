<script setup lang="ts">
import { computed, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useEditorTool } from '@/composables/useEditorTool';
import { setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { EDITOR_TOOL_DEFS } from '@/ui/editor/tools';
import { useI18n } from '@/ui/i18n';
import GuidanceLegend from './GuidanceLegend.vue';
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
const laneVisible = defineModel<boolean>('laneVisible', { required: true });
const snapToScale = defineModel<boolean>('snapToScale', { required: true });
const ghostMode = defineModel<'all' | 'active-track' | 'none'>('ghostMode', { required: true });
const ghostHideMuted = defineModel<boolean>('ghostHideMuted', { required: true });
const noteColorMode = defineModel<'track' | 'velocity' | 'channel'>('noteColorMode', {
  required: true,
});
const auditionDrag = defineModel<boolean>('auditionDrag', { required: true });

const props = defineProps<{
  /** True when a MIDI clip is active and can receive a transform. */
  canTransform: boolean;
  /** Active clip id passed to the transform popover. */
  clipId: number;
  /** Active clip note count passed to the transform preview. */
  noteCount: number;
  /** Disable the lane toggle while another panel temporarily owns that space. */
  laneToggleDisabled?: boolean;
}>();

const emit = defineEmits<{
  /** Zoom the timeline horizontally by the given factor. */
  zoomHorizontal: [factor: number];
  /** Zoom the pitch rows vertically by the given factor. */
  zoomVertical: [factor: number];
  /** Fit the full clip window. */
  fitClip: [];
  /** Fit all notes in the active clip. */
  fitNotes: [];
  /** Fit the current note selection, falling back to all notes. */
  fitSelection: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const { tool } = useEditorTool();
const activeTool = computed(
  () => EDITOR_TOOL_DEFS.find((def) => def.id === tool.value) ?? EDITOR_TOOL_DEFS[0],
);
const ghostModeOptions = computed(() => [
  { value: 'all' as const, label: t.value.shell.pianoRoll.ghostAll },
  { value: 'active-track' as const, label: t.value.shell.pianoRoll.ghostActiveTrack },
  { value: 'none' as const, label: t.value.shell.pianoRoll.ghostNone },
]);
const noteColorModeOptions = computed(() => [
  { value: 'track' as const, label: t.value.shell.pianoRoll.colorTrack },
  { value: 'velocity' as const, label: t.value.shell.pianoRoll.colorVelocity },
  { value: 'channel' as const, label: t.value.shell.pianoRoll.colorChannel },
]);

/** Whether the composition-guidance legend popover is open. */
const legendOpen = ref(false);

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
    <ToggleButton v-model="overlayEnabled" :label="t.shell.pianoRoll.overlay" size="sm" />
    <ToggleButton
      v-model="snapToScale"
      :label="t.shell.pianoRoll.snapScaleToggle"
      :title="t.shell.pianoRoll.snapScaleToggleTitle"
      size="sm"
    />
    <div class="tool-readout" :title="activeTool.hint" aria-live="polite">
      <span class="tool-readout__glyph" aria-hidden="true">{{ activeTool.glyph }}</span>
      <span>{{ activeTool.label }}</span>
    </div>
    <SelectMenu
      v-model="ghostMode"
      class="toolbar-select"
      size="sm"
      :options="ghostModeOptions"
      :aria-label="t.shell.pianoRoll.ghostMode"
    />
    <ToggleButton
      v-model="ghostHideMuted"
      :label="t.shell.pianoRoll.ghostHideMuted"
      :title="t.shell.pianoRoll.ghostHideMutedTitle"
      size="sm"
    />
    <SelectMenu
      v-model="noteColorMode"
      class="toolbar-select"
      size="sm"
      :options="noteColorModeOptions"
      :aria-label="t.shell.pianoRoll.noteColorMode"
    />
    <ToggleButton
      v-model="auditionDrag"
      :label="t.shell.pianoRoll.auditionDrag"
      :title="t.shell.pianoRoll.auditionDragTitle"
      size="sm"
    />
    <div class="track-legend">
      <button
        v-for="track in store.tracks"
        :key="track.id"
        type="button"
        class="legend-chip"
        :class="{ 'legend-chip-active': track.id === store.activeTrackId }"
        v-tooltip="track.name"
        @click="onLegendClick(track.id)"
      >
        <span class="chip-swatch" :style="{ background: track.color }" />
        <span class="chip-name">{{ track.name }}</span>
      </button>
    </div>
    <div class="zoom-cluster" role="group" :aria-label="t.shell.pianoRoll.zoom">
      <span class="fit-pair">
        <button
          type="button"
          class="fit-btn"
          v-tooltip="t.shell.pianoRoll.fitClipTitle"
          :aria-label="t.shell.pianoRoll.fitClip"
          @click="emit('fitClip')"
        >
          Clip
        </button>
        <button
          type="button"
          class="fit-btn"
          v-tooltip="t.shell.pianoRoll.fitNotesTitle"
          :aria-label="t.shell.pianoRoll.fitNotes"
          @click="emit('fitNotes')"
        >
          Notes
        </button>
        <button
          type="button"
          class="fit-btn"
          v-tooltip="t.shell.pianoRoll.fitSelectionTitle"
          :aria-label="t.shell.pianoRoll.fitSelection"
          @click="emit('fitSelection')"
        >
          Sel
        </button>
      </span>
      <span class="zoom-pair">
        <button
          type="button"
          class="zoom-btn"
          v-tooltip="t.shell.pianoRoll.zoomOutTimeTitle"
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
          v-tooltip="t.shell.pianoRoll.zoomInTimeTitle"
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
          v-tooltip="t.shell.pianoRoll.zoomOutPitchTitle"
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
          v-tooltip="t.shell.pianoRoll.zoomInPitchTitle"
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
    <ToggleButton
      v-model="laneVisible"
      class="lane-toggle"
      size="sm"
      :label="t.shell.pianoRoll.laneToggle"
      :title="t.shell.pianoRoll.laneToggleTitle"
      :disabled="props.laneToggleDisabled === true"
    />
    <button
      type="button"
      class="fx-toggle"
      :class="{ 'fx-toggle-active': fxPanelOpen }"
      :disabled="!canTransform"
      :aria-expanded="fxPanelOpen"
      v-tooltip="t.shell.pianoRoll.midiFxTitle"
      @click="toggleFxPanel"
    >
      {{ t.shell.pianoRoll.midiFx }}
    </button>
    <button
      type="button"
      class="fx-toggle"
      :class="{ 'fx-toggle-active': legendOpen }"
      :aria-expanded="legendOpen"
      v-tooltip="t.shell.pianoRoll.guideTitle"
      @click="legendOpen = !legendOpen"
    >
      {{ t.shell.pianoRoll.guide }}
    </button>
    <GuidanceLegend v-if="legendOpen" @close="legendOpen = false" />
    <MidiFxPanel
      v-if="fxPanelOpen && canTransform"
      :clip-id="clipId"
      :note-count="noteCount"
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

.tool-readout {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 4.8rem;
  padding: 0.1rem 0.45rem;
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
  color: var(--text-2);
  font: var(--fw-semibold) var(--fs-xs) / 1.4 var(--font-sans);
}

.tool-readout__glyph {
  color: var(--accent);
}

.toolbar-select {
  flex: 0 0 auto;
  /* SelectMenu's root is width:100%, meant to fill a constraining parent. As a
   * non-shrinking flex item here that would resolve to the full toolbar width,
   * blowing the bar out and pushing the zoom cluster off-screen. Size it to its
   * own content instead, bounded so a long label cannot dominate the bar. */
  width: auto;
  min-width: 6.4rem;
  max-width: 12rem;
}

.zoom-pair {
  display: flex;
  align-items: center;
  gap: 2px;
}

.fit-pair {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Inherits the controls.css raised-face baseline (hover/active/press); only the
 * compact metrics and surface tint differ from the canonical button. */
.zoom-btn,
.fit-btn {
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

.fit-btn {
  min-width: 2.4rem;
  padding-inline: 0.45rem;
}

.zoom-btn:hover:not(:disabled),
.fit-btn:hover:not(:disabled),
.fx-toggle:hover:not(:disabled) {
  color: var(--text-1);
}

.lane-toggle {
  flex: none;
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

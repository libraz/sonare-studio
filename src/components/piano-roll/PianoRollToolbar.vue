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
import OrnamentPanel from './OrnamentPanel.vue';
import { ZOOM_BUTTON_STEP } from './use-piano-roll-zoom';

/**
 * Toolbar above the piano-roll grid: the multi-track ghost overlay toggle, a
 * track-color legend that focuses a track on click, the horizontal/vertical
 * zoom buttons and the MIDI-FX transform and decoration popover toggles. The
 * overlay flag and the transform popover open state are two-way bound to the
 * editor; the legend reads the project store directly. The two popovers share
 * the same corner, so opening one closes the other.
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
const autoReharmonize = defineModel<boolean>('autoReharmonize', { required: true });
const placementGuide = defineModel<boolean>('placementGuide', { required: true });
const guidanceTint = defineModel<boolean>('guidanceTint', { required: true });

const props = defineProps<{
  /** True while the active track is frozen and content mutations are blocked. */
  readOnly?: boolean;
  /** True when the active track is percussion and melodic guidance is inapplicable. */
  drumTrack?: boolean;
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

/** Whether the decoration popover is open. */
const ornamentOpen = ref(false);

/** Toggles the transform popover (closing it when no MIDI clip is active). */
function toggleFxPanel(): void {
  if (!props.canTransform) return;
  fxPanelOpen.value = !fxPanelOpen.value;
  // The two popovers occupy the same corner, so one opening closes the other.
  if (fxPanelOpen.value) ornamentOpen.value = false;
}

/** Toggles the decoration popover (closing it when no MIDI clip is active). */
function toggleOrnamentPanel(): void {
  if (!props.canTransform) return;
  ornamentOpen.value = !ornamentOpen.value;
  if (ornamentOpen.value) fxPanelOpen.value = false;
}

/** Legend chip click: focuses the track (activates its first clip, if any). */
function onLegendClick(trackId: number): void {
  // Re-clicking the active track keeps the currently active clip.
  if (trackId === store.activeTrackId) return;
  setActiveTrack(trackId);
}
</script>

<template>
  <div class="roll-toolbar" @wheel.stop>
    <div class="roll-toolbar-scroll" @wheel.stop>
      <ToggleButton v-model="overlayEnabled" :label="t.shell.pianoRoll.overlay" size="sm" />
      <ToggleButton
        v-model="snapToScale"
        :label="t.shell.pianoRoll.snapScaleToggle"
        :title="t.shell.pianoRoll.snapScaleToggleTitle"
        :disabled="props.drumTrack === true"
        size="sm"
      />
      <div class="tool-readout" :title="activeTool.hint" aria-live="polite">
        <span :key="activeTool.id" class="tool-readout__glyph animate-pop" aria-hidden="true">{{
          activeTool.glyph
        }}</span>
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
      <ToggleButton
        v-model="autoReharmonize"
        :label="t.shell.pianoRoll.reharmonize.toggle"
        :title="t.shell.pianoRoll.reharmonize.toggleTitle"
        :disabled="props.readOnly === true || props.drumTrack === true"
        size="sm"
      />
      <ToggleButton
        v-model="placementGuide"
        :label="t.shell.pianoRoll.placementGuideToggle"
        :title="t.shell.pianoRoll.placementGuideToggleTitle"
        size="sm"
      />
      <ToggleButton
        v-model="guidanceTint"
        :label="t.shell.pianoRoll.guidanceTintToggle"
        :title="t.shell.pianoRoll.guidanceTintToggleTitle"
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
            {{ t.shell.pianoRoll.fitClip }}
          </button>
          <button
            type="button"
            class="fit-btn"
            v-tooltip="t.shell.pianoRoll.fitNotesTitle"
            :aria-label="t.shell.pianoRoll.fitNotes"
            @click="emit('fitNotes')"
          >
            {{ t.shell.pianoRoll.fitNotes }}
          </button>
          <button
            type="button"
            class="fit-btn"
            v-tooltip="t.shell.pianoRoll.fitSelectionTitle"
            :aria-label="t.shell.pianoRoll.fitSelection"
            @click="emit('fitSelection')"
          >
            {{ t.shell.pianoRoll.fitSelection }}
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
        :class="{ 'fx-toggle-active': ornamentOpen }"
        :disabled="!canTransform"
        :aria-expanded="ornamentOpen"
        v-tooltip="t.shell.pianoRoll.ornamentTitle"
        @click="toggleOrnamentPanel"
      >
        {{ t.shell.pianoRoll.ornamentToggle }}
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
    </div>
    <Transition name="pop">
      <GuidanceLegend v-if="legendOpen" @close="legendOpen = false" />
    </Transition>
    <Transition name="pop">
      <MidiFxPanel
        v-if="fxPanelOpen && canTransform"
        :clip-id="clipId"
        :note-count="noteCount"
        @close="fxPanelOpen = false"
      />
    </Transition>
    <Transition name="pop">
      <OrnamentPanel
        v-if="ornamentOpen && canTransform"
        :clip-id="clipId"
        @close="ornamentOpen = false"
      />
    </Transition>
  </div>
</template>

<style scoped>
.roll-toolbar {
  position: relative;
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-strong);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.roll-toolbar-scroll {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.25rem 0.5rem;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  white-space: nowrap;
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
  /* Re-keyed per tool so the glyph pops on a tool switch; inline-block lets it scale. */
  display: inline-block;
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

.zoom-btn,
.fit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 1.6rem;
  padding: 0.1rem 0.3rem;
  font: var(--fw-semibold) var(--fs-xs) var(--font-sans);
  background: transparent;
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
  background: var(--surface-3);
}

.zoom-btn:focus-visible,
.fit-btn:focus-visible,
.fx-toggle:focus-visible {
  outline: none;
  box-shadow: var(--ring);
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
  background: transparent;
  border-radius: var(--radius-sm);
}

.fx-toggle-active {
  background: var(--surface-selection);
  color: var(--accent);
  box-shadow: none;
}

.fx-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.track-legend {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  max-width: min(25rem, 40vw);
  overflow-x: auto;
}

.legend-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.45rem;
  border: none;
  border-radius: var(--radius-sm);
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

.legend-chip-active {
  background: var(--accent-soft);
  box-shadow: none;
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.legend-chip-active:focus-visible {
  box-shadow: var(--ring);
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

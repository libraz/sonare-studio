<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useEditorTool } from '@/composables/useEditorTool';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { EDITOR_TOOL_DEFS } from '@/ui/editor/tools';
import { formatMessage, useI18n } from '@/ui/i18n';
import { DEFAULT_APP_SETTINGS } from '@/ui/settings/app-settings';
import GuidanceLegend from './GuidanceLegend.vue';
import MidiFxPanel from './MidiFxPanel.vue';
import OrnamentPanel from './OrnamentPanel.vue';
import { ZOOM_BUTTON_STEP } from './use-piano-roll-zoom';

/**
 * Toolbar above the piano-roll grid, in three regions: the editing toggles and
 * the View popover (ghost overlay, note colours, audition, guidance display) on
 * the left, the track-colour legend in the middle (the only part that scrolls
 * when space runs out), and the fit / zoom actions plus the panel toggles on
 * the right. Toggle and popover state is two-way bound to the editor; the
 * legend reads the project store directly. The MIDI-FX and decoration
 * popovers share a corner, so opening one closes the other.
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

const editorReasons = computed(() => t.value.shell.editor.reasons);
const drumGate = computed(() => [props.drumTrack === true, editorReasons.value.drumTrack] as const);
const frozenGate = computed(() => [props.readOnly === true, t.value.reasons.trackFrozen] as const);
/** Scale snap reads the highlighted scale, so it does nothing while the highlight is off. */
const snapScaleBlocked = computed(() =>
  firstBlock(drumGate.value, [
    !store.scaleHighlight.enabled,
    editorReasons.value.scaleHighlightOff,
  ]),
);
const reharmonizeBlocked = computed(() => firstBlock(frozenGate.value, drumGate.value));
const guidanceBlocked = computed(() => firstBlock(drumGate.value));
const ghostScopeBlocked = computed(() =>
  firstBlock([!overlayEnabled.value, editorReasons.value.overlayOff]),
);
const ghostHideMutedBlocked = computed(() =>
  firstBlock(ghostScopeBlocked.value, [ghostMode.value === 'none', editorReasons.value.noGhosts]),
);
const laneBlocked = computed(() =>
  firstBlock([props.laneToggleDisabled === true, editorReasons.value.scoreOwnsLane]),
);
const transformBlocked = computed(() =>
  firstBlock(frozenGate.value, [!props.canTransform, t.value.reasons.noMidiClip]),
);

/** True when a View setting departs from its default, so the closed trigger still says so. */
const viewCustomized = computed(
  () =>
    !overlayEnabled.value ||
    ghostMode.value !== DEFAULT_APP_SETTINGS.pianoRollGhostMode ||
    ghostHideMuted.value !== DEFAULT_APP_SETTINGS.pianoRollGhostHideMuted ||
    noteColorMode.value !== DEFAULT_APP_SETTINGS.pianoRollNoteColorMode ||
    auditionDrag.value !== DEFAULT_APP_SETTINGS.pianoRollAuditionDrag ||
    placementGuide.value !== DEFAULT_APP_SETTINGS.pianoRollPlacementGuide ||
    guidanceTint.value !== DEFAULT_APP_SETTINGS.pianoRollGuidanceTint,
);

/** Whether the composition-guidance legend popover is open. */
const legendOpen = ref(false);

/** Whether the decoration popover is open. */
const ornamentOpen = ref(false);

/** Whether the View popover is open, and its left offset under its trigger. */
const viewOpen = ref(false);
const viewLeft = ref(0);
const viewTrigger = ref<HTMLButtonElement | null>(null);
const viewPopover = ref<HTMLDivElement | null>(null);

/** Toggles the View popover, anchored under its trigger. */
function toggleView(): void {
  const trigger = viewTrigger.value;
  if (trigger) viewLeft.value = trigger.offsetLeft;
  viewOpen.value = !viewOpen.value;
  if (viewOpen.value) void nextTick().then(() => viewPopover.value?.focus());
}

useOutsidePointerDown(
  viewOpen,
  (target) =>
    !!viewPopover.value?.contains(target) ||
    !!viewTrigger.value?.contains(target) ||
    // A SelectMenu list teleports outside the popover; a press inside it is still ours.
    (target instanceof Element && !!target.closest('[role="listbox"]')),
  () => {
    viewOpen.value = false;
  },
);

/** Escape closes the popover and hands focus back to its trigger. */
function closeView(): void {
  viewOpen.value = false;
  viewTrigger.value?.focus();
}

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
    <div class="roll-toolbar-row">
      <div class="tb-region">
        <div
          class="tool-readout"
          aria-live="polite"
          v-tooltip="{
            text: t.shell.tools.hints[activeTool.id],
            shortcut: `tool.${activeTool.id}`,
          }"
        >
          <span :key="activeTool.id" class="tool-readout__glyph animate-pop" aria-hidden="true">{{
            activeTool.glyph
          }}</span>
          <span>{{ t.shell.tools.names[activeTool.id] }}</span>
        </div>
        <span class="tb-sep" aria-hidden="true" />
        <ToggleButton
          v-model="snapToScale"
          :label="t.shell.pianoRoll.snapScaleToggle"
          :title="t.shell.pianoRoll.snapScaleToggleTitle"
          :reason="snapScaleBlocked"
          size="sm"
        />
        <ToggleButton
          v-model="autoReharmonize"
          :label="t.shell.pianoRoll.reharmonize.toggle"
          :title="t.shell.pianoRoll.reharmonize.toggleTitle"
          :reason="reharmonizeBlocked"
          size="sm"
        />
        <button
          ref="viewTrigger"
          type="button"
          class="tb-menu"
          :class="{ 'is-open': viewOpen, 'is-customized': viewCustomized }"
          aria-haspopup="dialog"
          :aria-expanded="viewOpen"
          v-tooltip="t.shell.pianoRoll.viewTitle"
          @click="toggleView"
        >
          {{ t.shell.pianoRoll.view }}
          <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <span class="tb-sep" aria-hidden="true" />
      <div class="track-legend">
        <button
          v-for="track in store.tracks"
          :key="track.id"
          type="button"
          class="legend-chip"
          :class="{ 'legend-chip-active': track.id === store.activeTrackId }"
          :aria-pressed="track.id === store.activeTrackId"
          v-tooltip="formatMessage(t.shell.pianoRoll.focusTrackTitle, { name: track.name })"
          @click="onLegendClick(track.id)"
        >
          <span class="chip-swatch" :style="{ background: track.color }" />
          <span class="chip-name">{{ track.name }}</span>
        </button>
      </div>
      <div class="tb-region tb-region-end">
        <div class="tb-segmented" role="group" :aria-label="t.shell.pianoRoll.zoom">
          <button
            type="button"
            class="tb-seg"
            v-tooltip="t.shell.pianoRoll.fitClipTitle"
            @click="emit('fitClip')"
          >
            {{ t.shell.pianoRoll.fitClip }}
          </button>
          <button
            type="button"
            class="tb-seg"
            v-tooltip="t.shell.pianoRoll.fitNotesTitle"
            @click="emit('fitNotes')"
          >
            {{ t.shell.pianoRoll.fitNotes }}
          </button>
          <button
            type="button"
            class="tb-seg"
            v-tooltip="{ text: t.shell.pianoRoll.fitSelectionTitle, shortcut: 'view.zoomToFit' }"
            @click="emit('fitSelection')"
          >
            {{ t.shell.pianoRoll.fitSelection }}
          </button>
        </div>
        <div class="tb-segmented">
          <button
            type="button"
            class="tb-seg tb-seg-icon"
            v-tooltip="{ text: t.shell.pianoRoll.zoomOutTimeTitle, shortcut: 'view.zoomOut' }"
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
            class="tb-seg tb-seg-icon"
            v-tooltip="{ text: t.shell.pianoRoll.zoomInTimeTitle, shortcut: 'view.zoomIn' }"
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
          <button
            type="button"
            class="tb-seg tb-seg-icon"
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
            class="tb-seg tb-seg-icon"
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
        </div>
        <span class="tb-sep" aria-hidden="true" />
        <ToggleButton
          v-model="laneVisible"
          size="sm"
          :label="t.shell.pianoRoll.laneToggle"
          :title="t.shell.pianoRoll.laneToggleTitle"
          :reason="laneBlocked"
        />
        <button
          type="button"
          class="tb-menu"
          :class="{ 'is-open': fxPanelOpen }"
          :disabled="!!transformBlocked"
          aria-haspopup="dialog"
          :aria-expanded="fxPanelOpen"
          v-tooltip="{ text: t.shell.pianoRoll.midiFxTitle, reason: transformBlocked }"
          @click="toggleFxPanel"
        >
          {{ t.shell.pianoRoll.midiFx }}
          <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-menu"
          :class="{ 'is-open': ornamentOpen }"
          :disabled="!!transformBlocked"
          aria-haspopup="dialog"
          :aria-expanded="ornamentOpen"
          v-tooltip="{ text: t.shell.pianoRoll.ornamentTitle, reason: transformBlocked }"
          @click="toggleOrnamentPanel"
        >
          {{ t.shell.pianoRoll.ornamentToggle }}
          <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-menu"
          :class="{ 'is-open': legendOpen }"
          aria-haspopup="dialog"
          :aria-expanded="legendOpen"
          v-tooltip="t.shell.pianoRoll.guideTitle"
          @click="legendOpen = !legendOpen"
        >
          {{ t.shell.pianoRoll.guide }}
          <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <Transition name="pop">
      <div
        v-if="viewOpen"
        ref="viewPopover"
        class="view-popover"
        role="dialog"
        tabindex="-1"
        :aria-label="t.shell.pianoRoll.view"
        :style="{ left: `${viewLeft}px` }"
        @keydown.esc.stop="closeView"
      >
        <p class="view-heading">{{ t.shell.pianoRoll.viewGhosts }}</p>
        <div class="view-row">
          <ToggleButton
            v-model="overlayEnabled"
            :label="t.shell.pianoRoll.overlay"
            :title="t.shell.pianoRoll.overlayTitle"
            size="sm"
          />
          <SelectMenu
            v-model="ghostMode"
            class="view-select"
            size="sm"
            :options="ghostModeOptions"
            :aria-label="t.shell.pianoRoll.ghostMode"
            :title="t.shell.pianoRoll.ghostModeTitle"
            :reason="ghostScopeBlocked"
          />
          <ToggleButton
            v-model="ghostHideMuted"
            :label="t.shell.pianoRoll.ghostHideMuted"
            :title="t.shell.pianoRoll.ghostHideMutedTitle"
            :reason="ghostHideMutedBlocked"
            size="sm"
          />
        </div>
        <p class="view-heading">{{ t.shell.pianoRoll.viewNotes }}</p>
        <div class="view-row">
          <SelectMenu
            v-model="noteColorMode"
            class="view-select"
            size="sm"
            :options="noteColorModeOptions"
            :aria-label="t.shell.pianoRoll.noteColorMode"
            :title="t.shell.pianoRoll.noteColorModeTitle"
          />
          <ToggleButton
            v-model="auditionDrag"
            :label="t.shell.pianoRoll.auditionDrag"
            :title="t.shell.pianoRoll.auditionDragTitle"
            size="sm"
          />
        </div>
        <p class="view-heading">{{ t.shell.pianoRoll.viewGuidance }}</p>
        <div class="view-row">
          <ToggleButton
            v-model="placementGuide"
            :label="t.shell.pianoRoll.placementGuideToggle"
            :title="t.shell.pianoRoll.placementGuideToggleTitle"
            :reason="guidanceBlocked"
            size="sm"
          />
          <ToggleButton
            v-model="guidanceTint"
            :label="t.shell.pianoRoll.guidanceTintToggle"
            :title="t.shell.pianoRoll.guidanceTintToggleTitle"
            :reason="guidanceBlocked"
            size="sm"
          />
        </div>
      </div>
    </Transition>
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

/* Fixed regions at both ends; only the track legend shrinks and scrolls. The
 * row itself scrolls as a last resort on a very narrow dock. */
.roll-toolbar-row {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  min-width: 0;
  padding: var(--sp-2) var(--sp-4);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  white-space: nowrap;
}

.tb-region {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.tb-region-end {
  margin-left: auto;
  gap: var(--sp-3);
}

.tb-sep {
  flex: none;
  width: 1px;
  height: 16px;
  background: var(--border);
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

/* Popover triggers: label plus caret, lit while open. */
.tb-menu {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  font: var(--fw-medium) var(--fs-xs) / 1.4 var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border-radius: var(--radius-md);
}

.tb-menu:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--control-bg-hover);
}

.tb-menu.is-open {
  background: var(--surface-selection);
  color: var(--accent);
}

/* A View setting off its default: the caret takes the accent so it is not hidden state. */
.tb-menu.is-customized .tb-caret {
  color: var(--accent);
  opacity: 1;
}

.tb-menu:disabled {
  opacity: 0.45;
  cursor: default;
}

.tb-caret {
  flex: none;
  opacity: 0.6;
}

/* One-shot actions share a hairline segmented face, unlike the borderless toggles. */
.tb-segmented {
  flex: none;
  display: inline-flex;
  align-items: stretch;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--border);
  background: var(--surface-2);
  overflow: hidden;
}

.tb-seg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-1) var(--sp-3);
  font: var(--fw-medium) var(--fs-xs) / 1.4 var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border-radius: 0;
}

.tb-seg + .tb-seg {
  box-shadow: inset 1px 0 0 var(--border);
}

.tb-seg-icon {
  min-width: 1.6rem;
  padding-inline: var(--sp-2);
}

.tb-seg:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--control-bg-hover);
}

.tb-seg:focus-visible,
.tb-menu:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.track-legend {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--sp-1);
  min-width: 3rem;
  overflow-x: auto;
  scrollbar-width: none;
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
  font: var(--fs-xs) / 1.4 var(--font-sans);
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
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

/* Redundant non-color cue for the active track beyond the accent tint. */
.legend-chip-active .chip-swatch {
  box-shadow: 0 0 0 2px var(--accent-muted);
}

.chip-name {
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-popover {
  position: absolute;
  top: calc(100% + 2px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 15rem;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  background: var(--surface-2);
  border: 1px solid var(--border-raised);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  transform-origin: top left;
}

.view-popover:focus {
  outline: none;
}

.view-heading {
  margin: var(--sp-2) 0 0;
  font: var(--fw-semibold) var(--fs-2xs) / 1.4 var(--font-sans);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-4);
}

.view-heading:first-child {
  margin-top: 0;
}

.view-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.view-select {
  flex: 0 0 auto;
  /* SelectMenu's root fills its parent; size it to its content here. */
  width: auto;
  min-width: 7rem;
}
</style>

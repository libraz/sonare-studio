<script setup lang="ts">
import { computed } from 'vue';
import { formatBarBeatTick } from '@/components/lists/bar-beat';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import type { ControlSurfaceHandle } from '@/composables/useControlSurface';
import type { MidiLearnHandle } from '@/composables/useMidiLearn';
import type { MusicTypingHandle } from '@/composables/useMusicTyping';
import type { useStepInput } from '@/composables/useStepInput';
import type { WebMidiHandle } from '@/composables/useWebMidi';
import { quantizeSelection } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { snapChoices } from '@/ui/shell/app-shell-options';
import { useSnapChoice } from '@/ui/shell/use-snap-choice';

/**
 * Piano-roll toolbar: grid/snap, quantize, music typing and step input, Web
 * MIDI connect/learn, and the Apply action with the engine status dot.
 */

type StepInput = ReturnType<typeof useStepInput>;

const props = defineProps<{
  stepInput: StepInput;
  musicTyping: MusicTypingHandle;
  webMidi: WebMidiHandle;
  midiLearn: MidiLearnHandle;
  controlSurface: ControlSurfaceHandle;
  midiInputChoices: readonly { value: string; label: string }[];
  busy: boolean;
  engineRunning: boolean;
  applyPending: boolean;
  scheduledCount: number;
  /** Playhead position; a getter so only the consumers that need it re-read it. */
  readPositionPpq: () => number;
}>();

const midiInputSelection = defineModel<string>('midiInputSelection', { required: true });
const midiLearnOpen = defineModel<boolean>('midiLearnOpen', { required: true });

const emit = defineEmits<{
  toggleMusicTyping: [];
  toggleStepInput: [];
  connectMidi: [];
  apply: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const snapChoice = useSnapChoice();

const applyStateText = computed(() => {
  if (!props.engineRunning) return t.value.shell.editor.engineOff;
  if (props.applyPending) return t.value.shell.editor.pending;
  return formatMessage(t.value.shell.editor.clipCount, { count: String(props.scheduledCount) });
});

/** Quantize edits the selected notes of the active track. */
const quantizeBlocked = computed(() =>
  firstBlock(
    [store.selection.size === 0, t.value.reasons.noNoteSelection],
    [store.activeTrack?.frozen !== undefined, t.value.reasons.trackFrozen],
  ),
);

/** Apply bounces through a live engine into a loaded project. */
const applyBlocked = computed(() =>
  firstBlock(
    [!props.engineRunning, t.value.reasons.engineOff],
    [!store.initialized, t.value.reasons.projectLoading],
  ),
);

/** Engine status dot state: off (no engine), pending (bouncing), or running. */
const engineStatusState = computed(() => {
  if (!props.engineRunning) return 'off';
  if (props.applyPending) return 'pending';
  return 'on';
});

/** Web MIDI exists in this browser unless a connect attempt has proven otherwise. */
const webMidiSupported = computed(
  () =>
    typeof navigator !== 'undefined' &&
    'requestMIDIAccess' in navigator &&
    props.webMidi.available.value !== false,
);
const connectMidiBlocked = computed(() =>
  firstBlock(
    [!webMidiSupported.value, t.value.reasons.noWebMidi],
    [props.busy, t.value.reasons.busy],
  ),
);

function stepInputBack(): void {
  props.stepInput.back();
}

function stepInputCursorToPlayhead(): void {
  props.stepInput.setCursor(props.readPositionPpq());
}
</script>

<template>
  <div class="editor-toolbar">
    <div class="editor-toolbar-scroll">
      <div class="tb-group" role="group" :aria-label="t.shell.editor.groupGrid">
        <ToggleButton
          v-model="store.snapEnabled"
          size="sm"
          :label="t.shell.editor.snap"
          :title="t.shell.editor.snapToggleTitle"
          shortcut="view.toggleSnap"
        />
        <SelectMenu
          v-model="snapChoice"
          class="tb-select"
          :options="snapChoices(t.shell.editor.snapBar)"
          size="sm"
          :aria-label="t.shell.editor.snap"
          :title="t.shell.editor.snapGridTitle"
        />
        <ToggleButton
          v-model="store.scaleHighlight.enabled"
          size="sm"
          :label="t.shell.editor.scaleHighlight"
          :title="t.shell.editor.scaleHighlightTitle"
        />
      </div>
      <span class="tb-sep" aria-hidden="true" />
      <div class="tb-group">
        <button
          type="button"
          class="tb-action"
          :disabled="!!quantizeBlocked"
          v-tooltip="{
            text: t.shell.editor.quantizeTitle,
            shortcut: 'edit.quantizeSelection',
            reason: quantizeBlocked,
          }"
          @click="quantizeSelection()"
        >
          {{ t.shell.editor.quantize }}
        </button>
        <label class="bar-field" v-tooltip="t.shell.editor.quantizeStrengthTitle">
          {{ t.shell.editor.quantizeStrength }}
          <input
            v-model.number="store.quantizeStrength"
            class="tb-range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :aria-label="t.shell.editor.quantizeStrength"
          />
        </label>
        <label class="bar-field" v-tooltip="t.shell.editor.swingTitle">
          {{ t.shell.editor.swing }}
          <input
            v-model.number="store.quantizeSwing"
            class="tb-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :aria-label="t.shell.editor.swing"
          />
        </label>
      </div>
      <span class="tb-sep" aria-hidden="true" />
      <div class="tb-group" role="group" :aria-label="t.shell.editor.groupInput">
        <ToggleButton
          :model-value="musicTyping.enabled.value"
          size="sm"
          :label="t.shell.editor.musicTyping"
          :title="t.shell.editor.musicTypingTitle"
          @update:model-value="emit('toggleMusicTyping')"
        />
        <ToggleButton
          :model-value="stepInput.armed.value"
          size="sm"
          :label="t.shell.editor.stepInput"
          :title="t.shell.editor.stepInputTitle"
          @update:model-value="emit('toggleStepInput')"
        />
        <template v-if="stepInput.armed.value">
          <span class="step-cursor" v-tooltip="t.shell.editor.stepCursorTitle">
            @ {{ formatBarBeatTick(stepInput.cursorPpq.value, store.timeSignatures) }}
          </span>
          <button
            type="button"
            class="tb-action"
            v-tooltip="t.shell.editor.stepBackTitle"
            @click="stepInputBack"
          >
            {{ t.shell.editor.stepBack }}
          </button>
          <button
            type="button"
            class="tb-action"
            v-tooltip="t.shell.editor.stepCursorToPlayheadTitle"
            @click="stepInputCursorToPlayhead"
          >
            {{ t.shell.editor.stepCursorToPlayhead }}
          </button>
        </template>
      </div>
      <span class="tb-sep" aria-hidden="true" />
      <div class="tb-group" role="group" :aria-label="t.shell.editor.groupMidi">
        <!-- The input list fills only once access is granted, so it shows when connected. -->
        <span v-if="webMidi.connected.value" class="bar-field">
          {{ t.shell.editor.midiIn }}
          <SelectMenu
            v-model="midiInputSelection"
            class="tb-select"
            :options="midiInputChoices"
            size="sm"
            :aria-label="t.shell.editor.midiIn"
            :title="t.shell.editor.midiInTitle"
          />
        </span>
        <button
          v-if="!webMidi.connected.value"
          type="button"
          class="tb-action"
          :disabled="!!connectMidiBlocked"
          v-tooltip="{ text: t.shell.editor.connectMidiTitle, reason: connectMidiBlocked }"
          @click="emit('connectMidi')"
        >
          {{ t.shell.editor.connectMidi }}
        </button>
        <button
          v-else
          type="button"
          class="tb-action"
          v-tooltip="t.shell.editor.disconnectMidiTitle"
          @click="webMidi.disconnect()"
        >
          {{ t.shell.editor.disconnectMidi }}
        </button>
      </div>
    </div>
    <span class="midi-learn-anchor">
      <button
        type="button"
        class="tb-menu"
        :class="{ 'is-open': midiLearnOpen }"
        aria-haspopup="dialog"
        :aria-expanded="midiLearnOpen"
        v-tooltip="t.shell.editor.midiLearnTitle"
        @click="midiLearnOpen = !midiLearnOpen"
      >
        {{ t.shell.editor.midiLearn }}
        <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Transition name="pop">
        <MidiLearnPanel
          v-if="midiLearnOpen"
          :learn="midiLearn"
          :tracks="store.tracks"
          :surface="controlSurface"
          @close="midiLearnOpen = false"
        />
      </Transition>
    </span>
    <span class="tb-sep" aria-hidden="true" />
    <button
      type="button"
      class="tb-action"
      :disabled="!!applyBlocked"
      v-tooltip="{ text: t.shell.editor.applyTitle, reason: applyBlocked }"
      @click="emit('apply')"
    >
      {{ t.shell.editor.apply }}
    </button>
    <span
      class="engine-status"
      :class="`engine-status-${engineStatusState}`"
      role="status"
      tabindex="0"
      v-tooltip="applyStateText"
      :aria-label="`${t.shell.editor.engineStatus}: ${applyStateText}`"
    >
      <span class="engine-status-dot" aria-hidden="true" />
    </span>
  </div>
</template>

<style scoped src="./editor-toolbar.css"></style>

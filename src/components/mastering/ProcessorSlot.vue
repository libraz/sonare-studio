<script setup lang="ts">
import { inject } from 'vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import CloseIcon from '@/components/shell/CloseIcon.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { InsertSlot } from '@/project/mixer';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { MasteringControl } from '@/ui/mastering/chain-controls';
import { midiLearnMasteringTargetId } from '@/ui/midi/midi-learn';
import { categoryLabel, humanizeInsertName } from '@/ui/mixer/insert-catalog';

/**
 * One mastering processor slot: a drag-reorderable row (power, name, category
 * badge, remove) and, when expanded, its inline parameter knobs. The slot is
 * presentational; the chain edits, the drag-reorder plan and the parameter
 * gesture coalescing are owned by the panel, which this component drives via
 * emitted intents.
 */

const props = defineProps<{
  /** The processor slot state. */
  slot: InsertSlot;
  /** Slot position in the chain. */
  index: number;
  /** True when the parameter knobs are shown. */
  expanded: boolean;
  /** True while this slot is the drag source. */
  dragging: boolean;
  /** True when this slot is the current drop target. */
  dropTarget: boolean;
  /** Parameter controls for the expanded knobs (empty unless expanded). */
  controls: ReadonlyArray<MasteringControl>;
}>();

const emit = defineEmits<{
  (event: 'toggle-enabled', index: number): void;
  (event: 'toggle-expanded', index: number): void;
  (event: 'remove', index: number): void;
  (
    event: 'param-change',
    index: number,
    control: MasteringControl,
    value: number,
    commit: boolean,
  ): void;
  (event: 'drag-start', index: number, dragEvent: DragEvent): void;
  (event: 'drag-over', index: number, dragEvent: DragEvent): void;
  (event: 'drop', index: number): void;
  (event: 'drag-end'): void;
}>();

const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

function processorCategory(processor: string): string {
  return processor.includes('.') ? processor.slice(0, processor.indexOf('.')) : 'other';
}

/** Formatted knob value with the control's unit. */
function controlDisplay(control: MasteringControl): string {
  const value =
    Math.abs(control.value) >= 100 ? Math.round(control.value) : control.value.toFixed(1);
  return control.unit ? `${value} ${control.unit}` : `${value}`;
}

function learnMasteringId(index: number, control: MasteringControl): string {
  return midiLearnMasteringTargetId(props.slot.id ?? index, control.id);
}

function learnMasteringState(
  index: number,
  control: MasteringControl,
): 'armed' | 'bound' | 'unbound' | undefined {
  if (!midiLearn) return undefined;
  const id = learnMasteringId(index, control);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearnMastering(index: number, control: MasteringControl): void {
  midiLearn?.armId(learnMasteringId(index, control));
}

function onMidiForgetMastering(index: number, control: MasteringControl): void {
  midiLearn?.clearId(learnMasteringId(index, control));
}
</script>

<template>
  <div
    class="chain-slot"
    :class="{
      bypassed: !slot.enabled,
      dragging,
      'drop-target': dropTarget,
    }"
    draggable="true"
    @dragstart="emit('drag-start', index, $event)"
    @dragover="emit('drag-over', index, $event)"
    @drop="emit('drop', index)"
    @dragend="emit('drag-end')"
  >
    <span class="chain-drag" v-tooltip="t.shell.mastering.dragReorder" aria-hidden="true">
      <svg class="chain-drag-icon" viewBox="0 0 6 10" fill="currentColor" focusable="false">
        <circle cx="1.5" cy="2" r="0.9" />
        <circle cx="4.5" cy="2" r="0.9" />
        <circle cx="1.5" cy="5" r="0.9" />
        <circle cx="4.5" cy="5" r="0.9" />
        <circle cx="1.5" cy="8" r="0.9" />
        <circle cx="4.5" cy="8" r="0.9" />
      </svg>
    </span>
    <button
      type="button"
      class="chain-power"
      :class="{ on: slot.enabled }"
      v-tooltip="slot.enabled ? t.shell.mastering.bypassProcessor : t.shell.mastering.enableProcessor"
      :aria-label="
        formatMessage(t.shell.mastering.processorPower, {
          name: humanizeInsertName(slot.processor),
        })
      "
      :aria-pressed="slot.enabled"
      @click="emit('toggle-enabled', index)"
    />
    <button
      type="button"
      class="chain-name"
      :class="{ expanded }"
      v-tooltip="slot.processor"
      @click="emit('toggle-expanded', index)"
    >
      {{ humanizeInsertName(slot.processor) }}
    </button>
    <span class="chain-badge">{{ categoryLabel(processorCategory(slot.processor)) }}</span>
    <button
      type="button"
      class="chain-remove"
      v-tooltip="t.shell.mastering.removeProcessor"
      :aria-label="
        formatMessage(t.shell.mastering.removeNamed, {
          name: humanizeInsertName(slot.processor),
        })
      "
      @click="emit('remove', index)"
    >
      <CloseIcon class="chain-remove-icon" />
    </button>
  </div>
  <div v-if="expanded" class="chain-params">
    <EmptyState
      v-if="controls.length === 0"
      variant="inline"
      :message="t.shell.mastering.noParameters"
    />
    <div v-for="control in controls" :key="control.id" class="chain-param-control">
      <MixerKnob
        :value="control.value"
        :min="control.min"
        :max="control.max"
        :label="control.name"
        :display="controlDisplay(control)"
        :size="22"
        @change="(value, commit) => emit('param-change', index, control, value, commit)"
      />
      <div v-if="learnMasteringState(index, control)" class="chain-param-midi">
        <button
          type="button"
          class="chain-param-midi-learn"
          :class="learnMasteringState(index, control)"
          v-tooltip="
            learnMasteringState(index, control) === 'armed'
              ? t.shell.mixer.controls.midiLearnListening
              : t.shell.mixer.controls.midiLearn
          "
          :aria-label="t.shell.mixer.controls.midiLearn"
          @click="onMidiLearnMastering(index, control)"
        >
          MIDI
        </button>
        <button
          v-if="learnMasteringState(index, control) === 'bound'"
          type="button"
          class="chain-param-midi-forget"
          v-tooltip="t.shell.mixer.controls.midiForget"
          :aria-label="t.shell.mixer.controls.midiForget"
          @click="onMidiForgetMastering(index, control)"
        >
          ×
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./processor-slot.css"></style>

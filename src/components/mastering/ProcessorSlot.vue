<script setup lang="ts">
import { inject } from 'vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import CloseIcon from '@/components/shell/CloseIcon.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { InsertSlot } from '@/project/mixer';
import type { ProcessorControlValue } from '@/project/processor-controls';
import { formatProcessorControlValue } from '@/project/processor-controls';
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
  /** Whether the slot can move one place toward the chain input. */
  canMoveUp: boolean;
  /** Whether the slot can move one place toward the chain output. */
  canMoveDown: boolean;
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
  (event: 'move', index: number, delta: -1 | 1): void;
}>();

const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

function processorCategory(processor: string): string {
  return processor.includes('.') ? processor.slice(0, processor.indexOf('.')) : 'other';
}

/** Formatted knob value with the control's unit. */
function controlDisplay(control: MasteringControl): string {
  return formatProcessorControlValue(control);
}

function isNumberControl(control: MasteringControl): boolean {
  return control.kind === 'number' || !control.kind;
}

function numberControl(control: MasteringControl): {
  value: number;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  defaultValue?: number;
} {
  return control as Extract<MasteringControl, { kind: 'number' }>;
}

function enumControl(control: MasteringControl): Extract<MasteringControl, { kind: 'enum' }> {
  return control as Extract<MasteringControl, { kind: 'enum' }>;
}

/** ProcessorRack's legacy event carries a number; encode nonnumeric UI choices
 * as a transport ordinal and let MasteringPanel restore the native type. */
function emitBooleanChange(control: Extract<MasteringControl, { kind: 'boolean' }>): void {
  emit('param-change', props.index, control, control.value ? 0 : 1, true);
}

function emitEnumChange(
  control: Extract<MasteringControl, { kind: 'enum' }>,
  value: ProcessorControlValue,
): void {
  if (typeof value !== 'number') return;
  emit('param-change', props.index, control, value, true);
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
      class="chain-move"
      :disabled="!canMoveUp"
      :aria-label="formatMessage(t.shell.mastering.moveUp, { name: humanizeInsertName(slot.processor) })"
      @click="emit('move', index, -1)"
    >
      ↑
    </button>
    <button
      type="button"
      class="chain-move"
      :disabled="!canMoveDown"
      :aria-label="formatMessage(t.shell.mastering.moveDown, { name: humanizeInsertName(slot.processor) })"
      @click="emit('move', index, 1)"
    >
      ↓
    </button>
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
      <template v-if="isNumberControl(control)">
        <MixerKnob
          :value="numberControl(control).value"
          :min="numberControl(control).min"
          :max="numberControl(control).max"
          :scale="numberControl(control).scale"
          :default-value="numberControl(control).defaultValue"
          :label="control.name"
          :display="controlDisplay(control)"
          :size="22"
          @change="(value, commit) => emit('param-change', index, control, value, commit)"
        />
      </template>
      <button
        v-else-if="control.kind === 'boolean'"
        type="button"
        class="chain-param-toggle"
        :class="{ on: control.value }"
        :data-control="control.id"
        :aria-label="control.name"
        :aria-pressed="control.value"
        :title="`${control.name}: ${controlDisplay(control)}`"
        @click="emitBooleanChange(control)"
      >
        <span class="chain-param-label">{{ control.name }}</span>
        <span>{{ controlDisplay(control) }}</span>
      </button>
      <template v-else>
        <span class="chain-param-label">{{ control.name }}</span>
        <SelectMenu
          class="chain-param-select"
          :model-value="enumControl(control).value"
          :options="enumControl(control).options"
          :aria-label="control.name"
          :title="`${control.name}: ${controlDisplay(control)}`"
          size="sm"
          @change="(value) => emitEnumChange(enumControl(control), value)"
        />
      </template>
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

<style scoped>
.chain-param-toggle {
  min-width: 44px;
  min-height: 28px;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-3);
  background: var(--control-bg);
  box-shadow: var(--control-lift);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  cursor: pointer;
}

.chain-param-toggle.on {
  color: var(--text-1);
  background: var(--accent-muted);
}

.chain-param-label {
  margin-right: 3px;
  color: var(--text-4);
  font: 8px var(--font-sans);
  text-transform: uppercase;
}

.chain-param-select {
  min-width: 100px;
}
</style>

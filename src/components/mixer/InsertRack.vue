<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { MeterSource } from '@/engine/meters';
import type { MixerStripTarget } from '@/project/commands';
import { isMixerBusStripTarget, mixerBusIdFromTarget } from '@/project/commands';
import { createDefaultStrip, type InsertSlot, type MixerStrip } from '@/project/mixer';
import { formatProcessorControlValue } from '@/project/processor-controls';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { humanizeInsertName } from '@/ui/mixer/insert-catalog';
import {
  adjustExpandedAfterRemove,
  removeInsertSlot,
  toggleInsertEnabled,
} from '@/ui/mixer/insert-rack';
import type { SidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';
import { useInsertClipboard } from '@/ui/mixer/use-insert-clipboard';
import { useInsertGainReduction } from '@/ui/mixer/use-insert-gain-reduction';
import { useInsertParams } from '@/ui/mixer/use-insert-params';
import { useInsertReorder } from '@/ui/mixer/use-insert-reorder';
import { useInsertSidechain } from '@/ui/mixer/use-insert-sidechain';
import InsertAddMenu from './InsertAddMenu.vue';
import MixerKnob from './MixerKnob.vue';

/**
 * Insert chain section of a channel strip: one row per slot with a bypass
 * dot, name (click expands the parameter knobs inline) and remove button,
 * plus an add button opening the processor catalog grouped by category.
 * All edits go through the undoable command layer; parameter knob drags
 * coalesce into one history entry via the quick-control gesture protocol.
 *
 * Sidechain-keyed processors (ducking/sidechainRouter) expose a compact key
 * source selector. Track, group-bus, return-bus and master inserts use the same
 * control; self-routes and bus feedback loops are disabled in the menu, as
 * are sources the running engine would refuse, with the reason as detail.
 *
 * Slots whose processor has reported gain reduction keep a compact readout
 * and a hairline bar; processors that never reduce (EQ, reverb) show none.
 */

const props = withDefaults(
  defineProps<{
    /** Strip the rack edits: a track id or 'master'. */
    target: MixerStripTarget;
    /** Meter source of the engine strip running these inserts. */
    meter?: MeterSource | null;
    /** Whether the mixer dock is visible and readouts should refresh. */
    visible?: boolean;
    /** Engine sidechain refusal lookup; null without a running engine. */
    sidechainRefusal?: SidechainRefusalLookup | null;
  }>(),
  { meter: null, visible: true, sidechainRefusal: null },
);

const store = useProjectStore();
const { t } = useI18n();

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(props.target)) {
    const busId = mixerBusIdFromTarget(props.target);
    return store.mixer.buses.find((bus) => bus.id === busId)?.strip ?? createDefaultStrip();
  }
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const { slotGrDb, hasGrReadout, grLabel, grFraction } = useInsertGainReduction({ props, strip });

/** Surfaced when a command rejects (e.g. unknown processor at apply time). */
const error = ref('');

const {
  expandedIndex,
  expandedControls,
  toggleExpanded,
  onParamChange,
  coupledNote,
  onBooleanToggle,
  onEnumChange,
  learnState,
  onMidiLearn,
  onMidiForget,
} = useInsertParams({ props, strip, error });

const { onSlotContextMenu } = useInsertClipboard({ props, strip, expandedIndex, error });

// --- Slot actions ------------------------------------------------------------

function onToggleEnabled(index: number): void {
  toggleInsertEnabled(props.target, index, strip.value.inserts[index]);
}

function insertPowerTooltip(slot: InsertSlot): string {
  if (isMixerBusStripTarget(props.target)) {
    return slot.enabled ? t.value.shell.inserts.busBypass : t.value.shell.inserts.busEnable;
  }
  return slot.enabled ? t.value.shell.inserts.bypass : t.value.shell.inserts.enable;
}

function onRemove(index: number): void {
  removeInsertSlot(props.target, index);
  expandedIndex.value = adjustExpandedAfterRemove(expandedIndex.value, index);
}

const { dragOverIndex, onDragStart, onDragOver, onDrop, onDragEnd } = useInsertReorder({
  props,
  strip,
  expandedIndex,
  error,
});

const {
  sidechainOptions,
  refreshSidechainChecks,
  sidechainValue,
  hasSidechainSelect,
  onSidechainChange,
} = useInsertSidechain({ props, expandedIndex, error });
</script>

<template>
  <div class="insert-rack">
    <template v-for="(slot, index) in strip.inserts" :key="index">
      <div
        class="insert-slot"
        :class="{ bypassed: !slot.enabled, 'drag-over': dragOverIndex === index }"
        @dragover="onDragOver(index, $event)"
        @drop="onDrop(index)"
        @dragend="onDragEnd"
        @contextmenu.prevent="onSlotContextMenu(index, $event)"
      >
        <span
          class="insert-drag"
          draggable="true"
          v-tooltip="t.shell.inserts.dragReorder"
          aria-hidden="true"
          @dragstart="onDragStart(index, $event)"
        >
          <svg viewBox="0 0 6 10" width="6" height="10" focusable="false">
            <circle cx="1.5" cy="1.5" r="1" />
            <circle cx="4.5" cy="1.5" r="1" />
            <circle cx="1.5" cy="5" r="1" />
            <circle cx="4.5" cy="5" r="1" />
            <circle cx="1.5" cy="8.5" r="1" />
            <circle cx="4.5" cy="8.5" r="1" />
          </svg>
        </span>
        <button
          type="button"
          class="insert-power"
          :class="{ on: slot.enabled }"
          v-tooltip="insertPowerTooltip(slot)"
          :aria-label="
            formatMessage(t.shell.inserts.power, { name: humanizeInsertName(slot.processor) })
          "
          :aria-pressed="slot.enabled"
          @click="onToggleEnabled(index)"
        />
        <button
          type="button"
          class="insert-name"
          :class="{ expanded: expandedIndex === index }"
          v-tooltip="slot.processor"
          @click="toggleExpanded(index)"
        >
          {{ humanizeInsertName(slot.processor) }}
        </button>
        <span
          v-if="hasGrReadout(slot, index)"
          class="insert-gr"
          :class="{ active: slotGrDb[index] !== undefined }"
          role="meter"
          :aria-label="
            formatMessage(t.shell.inserts.gainReduction, {
              name: humanizeInsertName(slot.processor),
            })
          "
          :aria-valuenow="slotGrDb[index] ?? 0"
          aria-valuemin="0"
        >
          {{ grLabel(index) }}
        </span>
        <span v-if="hasGrReadout(slot, index)" class="insert-gr-bar" aria-hidden="true">
          <span class="insert-gr-fill" :style="{ width: `${grFraction(index) * 100}%` }" />
        </span>
        <button
          type="button"
          class="insert-remove"
          v-tooltip="t.shell.inserts.remove"
          :aria-label="
            formatMessage(t.shell.inserts.removeNamed, { name: humanizeInsertName(slot.processor) })
          "
          @click="onRemove(index)"
        >
          ×
        </button>
      </div>
      <div v-if="expandedIndex === index" class="insert-params">
        <label
          v-if="hasSidechainSelect(slot)"
          class="insert-sidechain"
          @pointerdown.capture="refreshSidechainChecks"
          @keydown.capture="refreshSidechainChecks"
        >
          <span class="insert-sidechain-label">{{ t.shell.inserts.key }}</span>
          <SelectMenu
            class="insert-sidechain-select"
            :model-value="sidechainValue(slot)"
            :options="sidechainOptions"
            :aria-label="t.shell.inserts.sidechainKey"
            size="sm"
            @change="(value) => onSidechainChange(index, value)"
          />
        </label>
        <EmptyState
          v-if="expandedControls.length === 0"
          variant="inline"
          :message="t.shell.inserts.noParameters"
        />
        <template v-for="control in expandedControls" :key="control.id">
          <MixerKnob
            v-if="control.kind === 'number'"
            :value="control.value"
            :min="control.min"
            :max="control.max"
            :scale="control.scale"
            :default-value="control.defaultValue"
            :label="control.name"
            :display="formatProcessorControlValue(control)"
            :note="coupledNote(control)"
            :size="22"
            :midi-learn-state="learnState(control)"
            @change="(value, commit) => onParamChange(control, value, commit)"
            @midi-learn="onMidiLearn(control)"
            @midi-forget="onMidiForget(control)"
          />
          <div v-else-if="control.kind === 'boolean'" class="insert-param-value">
            <span class="insert-param-label" v-tooltip="control.name">{{ control.name }}</span>
            <button
              type="button"
              class="insert-param-toggle"
              :class="{ on: control.value }"
              :aria-label="control.name"
              :aria-pressed="control.value"
              v-tooltip="`${control.name}: ${formatProcessorControlValue(control)}`"
              :data-control="control.id"
              @click="onBooleanToggle(control)"
            >
              {{ formatProcessorControlValue(control) }}
            </button>
            <div v-if="learnState(control)" class="insert-param-midi">
              <button
                type="button"
                class="insert-param-midi-learn"
                :class="learnState(control)"
                v-tooltip="
                  learnState(control) === 'armed'
                    ? t.shell.mixer.controls.midiLearnListening
                    : t.shell.mixer.controls.midiLearn
                "
                :aria-label="t.shell.mixer.controls.midiLearn"
                @click="onMidiLearn(control)"
              >
                MIDI
              </button>
              <button
                v-if="learnState(control) === 'bound'"
                type="button"
                class="insert-param-midi-forget"
                v-tooltip="t.shell.mixer.controls.midiForget"
                :aria-label="t.shell.mixer.controls.midiForget"
                @click="onMidiForget(control)"
              >
                ×
              </button>
            </div>
          </div>
          <div v-else class="insert-param-value">
            <span class="insert-param-label" v-tooltip="control.name">{{ control.name }}</span>
            <SelectMenu
              class="insert-param-select"
              :model-value="control.value"
              :options="control.options"
              :aria-label="control.name"
              :title="`${control.name}: ${formatProcessorControlValue(control)}`"
              size="sm"
              @change="(value) => onEnumChange(control, value)"
            />
            <div v-if="learnState(control)" class="insert-param-midi">
              <button
                type="button"
                class="insert-param-midi-learn"
                :class="learnState(control)"
                v-tooltip="
                  learnState(control) === 'armed'
                    ? t.shell.mixer.controls.midiLearnListening
                    : t.shell.mixer.controls.midiLearn
                "
                :aria-label="t.shell.mixer.controls.midiLearn"
                @click="onMidiLearn(control)"
              >
                MIDI
              </button>
              <button
                v-if="learnState(control) === 'bound'"
                type="button"
                class="insert-param-midi-forget"
                v-tooltip="t.shell.mixer.controls.midiForget"
                :aria-label="t.shell.mixer.controls.midiForget"
                @click="onMidiForget(control)"
              >
                ×
              </button>
            </div>
          </div>
        </template>
      </div>
    </template>
    <InsertAddMenu v-model:expanded-index="expandedIndex" v-model:error="error" :target="target" />
    <p v-if="error" class="insert-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped src="./insert-rack.css"></style>

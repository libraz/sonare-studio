<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { ControlSurfaceHandle } from '@/composables/useControlSurface';
import { confirmDestructive } from '@/composables/useDialogs';
import type { MidiLearnHandle } from '@/composables/useMidiLearn';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  formatMidiCcBinding,
  MIDI_LEARN_BANK_ACTIONS,
  MIDI_LEARN_TRANSPORT_ACTIONS,
  type MidiCcBinding,
  type MidiLearnBankParam,
  type MidiLearnParam,
  type MidiLearnScope,
  midiLearnBankActionTargetId,
  midiLearnBankTargetId,
  midiLearnTransportTargetId,
  parseMidiLearnInsertTargetId,
  parseMidiLearnInstrumentTargetId,
} from '@/ui/midi/midi-learn';
import ControlSurfaceSettings from './ControlSurfaceSettings.vue';

/**
 * MIDI-learn popover: binds hardware CC controllers to mixer strip gain/pan for
 * the master strip and every track. Arming a target listens for the next CC;
 * incoming CC then drives the real mixer command in realtime (audible). Press
 * a bound control again to re-learn, or clear it with the ✕.
 */

const props = defineProps<{
  /** MIDI-learn state and controls. */
  learn: MidiLearnHandle;
  /** Tracks to expose as bindable strips, in display order. */
  tracks: ReadonlyArray<{ id: number; name: string; color: string }>;
  /** Control-surface ports and status; omitted when Web MIDI is unavailable. */
  surface?: ControlSurfaceHandle;
}>();

const emit = defineEmits<{
  /** Request the host close the panel. */
  close: [];
}>();

const { t } = useI18n();
const store = useProjectStore();
const panel = ref<HTMLElement | null>(null);

function close(): void {
  emit('close');
}

// The panel is dismissed by a press anywhere outside it for as long as it is mounted.
useOutsidePointerDown(
  () => true,
  (target) => !!panel.value?.contains(target),
  close,
);

onMounted(() => {
  // Focus the dialog itself, not its dismiss action: a screen reader then
  // announces the panel's name, and the first Tab reaches the bindings rather
  // than leaving the close button pre-armed under Enter.
  void nextTick().then(() => panel.value?.focus());
});

/** The two bindable parameters per strip, in column order. */
const PARAMS: ReadonlyArray<{ param: MidiLearnParam; labelKey: 'volume' | 'pan' }> = [
  { param: 'gain', labelKey: 'volume' },
  { param: 'pan', labelKey: 'pan' },
];

/**
 * Why learning cannot capture a CC right now. Without a surface handle the host
 * gave no MIDI status, so learning stays available.
 */
const learnBlocked = computed(() => {
  const surface = props.surface;
  if (!surface) return null;
  return firstBlock(
    [surface.available.value === false, t.value.reasons.noWebMidi],
    [surface.inputs.value.length === 0, t.value.reasons.noMidiAccess],
  );
});

/** Tooltip of a learn button: what a click does now, plus any blocking reason. */
function bindTip(armed: boolean) {
  return {
    text: armed ? t.value.shell.midiLearn.listeningTitle : t.value.shell.midiLearn.bindTitle,
    reason: learnBlocked.value,
  };
}

/** Tooltip of a clear button whose row may have nothing bound yet. */
function clearTip(bound: boolean) {
  return {
    text: t.value.shell.midiLearn.clearBinding,
    reason: bound ? null : t.value.shell.midiLearn.reasons.noBinding,
  };
}

/** Short caption for a target's button: its binding, listening, or a dash. */
function caption(param: MidiLearnParam, scope: MidiLearnScope): string {
  if (props.learn.isArmed(param, scope)) return t.value.shell.midiLearn.listening;
  const binding = props.learn.bindingFor(param, scope);
  return binding ? formatMidiCcBinding(binding) : t.value.shell.midiLearn.learn;
}

// --- Device (insert / instrument) bindings -----------------------------------

/** One listed insert/instrument binding with a human-readable label. */
interface DeviceBindingRow {
  /** Target id (passed to clearId on forget). */
  id: string;
  /** Display label, e.g. "Bass · Insert 2 · Threshold Db". */
  label: string;
  /** The bound channel + controller. */
  binding: MidiCcBinding;
}

/** camelCase parameter name to a spaced, capitalized label. */
function humanizeParam(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Display name of a binding's strip scope (track name or "Master"). */
function scopeName(scope: MidiLearnScope): string {
  if (scope === 'master') return t.value.shell.midiLearn.master;
  return props.tracks.find((track) => track.id === scope)?.name ?? '';
}

/**
 * Insert/instrument bindings derived from the learn map, sorted by label.
 * Strip gain/pan bindings are shown in the grid above and excluded here.
 */
const deviceBindings = computed<DeviceBindingRow[]>(() => {
  const rows: DeviceBindingRow[] = [];
  for (const [id, binding] of props.learn.bindings) {
    const insert = parseMidiLearnInsertTargetId(id);
    if (insert) {
      const strip =
        insert.scope === 'master'
          ? store.mixer.master
          : store.tracks.find((track) => track.id === insert.scope)?.mixer;
      const index =
        insert.processorId !== undefined
          ? (strip?.inserts.findIndex((slot) => slot.id === insert.processorId) ?? -1)
          : (insert.index ?? -1);
      const slot = formatMessage(t.value.shell.midiLearn.insertSlot, {
        index: index >= 0 ? String(index + 1) : '?',
      });
      rows.push({
        id,
        label: `${scopeName(insert.scope)} · ${slot} · ${humanizeParam(insert.paramId)}`,
        binding,
      });
      continue;
    }
    const instrument = parseMidiLearnInstrumentTargetId(id);
    if (instrument) {
      rows.push({
        id,
        label: `${scopeName(instrument.trackId)} · ${t.value.shell.midiLearn.instrument} · ${humanizeParam(instrument.paramId)}`,
        binding,
      });
    }
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
});

/** Transport buttons a control surface can drive, with their current binding. */
const transportRows = computed(() =>
  MIDI_LEARN_TRANSPORT_ACTIONS.map((action) => {
    const id = midiLearnTransportTargetId(action);
    return {
      id,
      action,
      label: t.value.shell.midiLearn.transportActions[action],
      binding: props.learn.bindingForId(id),
    };
  }),
);

// --- Control surface ---------------------------------------------------------

/** Slots the bank grid exposes: one per strip of the surface. */
const bankSlots = computed(() =>
  Array.from({ length: store.controlSurface.bankSize }, (_, i) => i),
);

/**
 * Bank-slot controls shown in the grid. Arm and select are driven by a surface
 * protocol rather than learned, so they are not offered here.
 */
type BankGridParam = Extract<MidiLearnBankParam, 'gain' | 'pan' | 'mute' | 'solo'>;
const BANK_PARAMS: ReadonlyArray<BankGridParam> = ['gain', 'pan', 'mute', 'solo'];

const clearAllBlocked = computed(() =>
  firstBlock([
    props.learn.bindings.size === 0 && props.learn.armed.value === null,
    t.value.shell.midiLearn.reasons.nothingToClear,
  ]),
);

/** Bank navigation buttons a generic controller can learn. */
const bankNavRows = computed(() =>
  MIDI_LEARN_BANK_ACTIONS.map((action) => {
    const id = midiLearnBankActionTargetId(action);
    return {
      id,
      label: t.value.shell.midiLearn.bankActions[action],
      binding: props.learn.bindingForId(id),
    };
  }),
);

/** Caption for a bank-slot button: its binding, listening, or "learn". */
function bankCaption(slot: number, param: BankGridParam): string {
  const id = midiLearnBankTargetId(slot, param);
  if (props.learn.isArmedId(id)) return t.value.shell.midiLearn.listening;
  const binding = props.learn.bindingForId(id);
  return binding ? formatMidiCcBinding(binding) : t.value.shell.midiLearn.learn;
}

function clearAll(): void {
  void (async () => {
    if (
      !(await confirmDestructive({
        title: t.value.shell.midiLearn.clearAllTitle,
        message: t.value.shell.midiLearn.clearAllMessage,
        confirmLabel: t.value.shell.midiLearn.clearAll,
      }))
    )
      return;
    props.learn.clearAll();
  })();
}
</script>

<template>
  <div
    ref="panel"
    class="midi-learn-panel"
    role="dialog"
    tabindex="-1"
    :aria-label="t.shell.midiLearn.label"
    @keydown.escape.stop.prevent="close"
  >
    <header class="ml-head">
      <h2 class="ml-title">{{ t.shell.midiLearn.title }}</h2>
      <button
        type="button"
        class="ml-close"
        :aria-label="t.common.close"
        v-tooltip="t.shell.midiLearn.closeTitle"
        @click="close"
      >
        ×
      </button>
    </header>

    <div class="ml-body">
      <div class="ml-row ml-row-head">
        <span class="ml-name">{{ t.shell.midiLearn.strip }}</span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-col-head">
          {{ t.shell.midiLearn[col.labelKey] }}
        </span>
      </div>

      <div class="ml-row">
        <span class="ml-name ml-name-master">{{ t.shell.midiLearn.master }}</span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-cell">
          <button
            type="button"
            class="ml-bind"
            :class="{
              'ml-bind-armed': learn.isArmed(col.param, 'master'),
              'ml-bind-set': !!learn.bindingFor(col.param, 'master'),
            }"
            :disabled="!!learnBlocked"
            v-tooltip="bindTip(learn.isArmed(col.param, 'master'))"
            @click="learn.arm(col.param, 'master')"
          >
            {{ caption(col.param, 'master') }}
          </button>
          <button
            v-if="learn.bindingFor(col.param, 'master')"
            type="button"
            class="ml-clear"
            :aria-label="t.shell.midiLearn.clearBinding"
            v-tooltip="t.shell.midiLearn.clearBinding"
            @click="learn.clear(col.param, 'master')"
          >
            ×
          </button>
        </span>
      </div>

      <div v-for="track in tracks" :key="track.id" class="ml-row">
        <span class="ml-name">
          <span class="ml-swatch" :style="{ background: track.color }" />
          {{ track.name }}
        </span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-cell">
          <button
            type="button"
            class="ml-bind"
            :class="{
              'ml-bind-armed': learn.isArmed(col.param, track.id),
              'ml-bind-set': !!learn.bindingFor(col.param, track.id),
            }"
            :disabled="!!learnBlocked"
            v-tooltip="bindTip(learn.isArmed(col.param, track.id))"
            @click="learn.arm(col.param, track.id)"
          >
            {{ caption(col.param, track.id) }}
          </button>
          <button
            v-if="learn.bindingFor(col.param, track.id)"
            type="button"
            class="ml-clear"
            :aria-label="t.shell.midiLearn.clearBinding"
            v-tooltip="t.shell.midiLearn.clearBinding"
            @click="learn.clear(col.param, track.id)"
          >
            ×
          </button>
        </span>
      </div>

      <ControlSurfaceSettings :surface="surface" :track-count="tracks.length" />

      <div class="ml-bank">
        <div class="ml-row-head ml-devices-head">
          <span class="ml-col-head">{{ t.shell.midiLearn.bank }}</span>
        </div>
        <div class="ml-row ml-bank-head">
          <span class="ml-row-head" />
          <span v-for="param in BANK_PARAMS" :key="param" class="ml-col-head">
            {{ t.shell.midiLearn.bankParams[param] }}
          </span>
        </div>
        <div v-for="slot in bankSlots" :key="slot" class="ml-row ml-bank-row">
          <span class="ml-row-head">
            {{ formatMessage(t.shell.midiLearn.bankSlot, { index: String(slot + 1) }) }}
          </span>
          <span v-for="param in BANK_PARAMS" :key="param" class="ml-cell">
            <button
              type="button"
              class="ml-bind ml-bind-bank"
              :class="{ 'ml-bind-armed': learn.isArmedId(midiLearnBankTargetId(slot, param)) }"
              :aria-pressed="learn.isArmedId(midiLearnBankTargetId(slot, param))"
              :disabled="!!learnBlocked"
              v-tooltip="bindTip(learn.isArmedId(midiLearnBankTargetId(slot, param)))"
              @click="learn.armId(midiLearnBankTargetId(slot, param))"
            >
              {{ bankCaption(slot, param) }}
            </button>
            <button
              type="button"
              class="ml-clear"
              :disabled="!learn.bindingForId(midiLearnBankTargetId(slot, param))"
              :aria-label="t.shell.midiLearn.clearBinding"
              v-tooltip="clearTip(!!learn.bindingForId(midiLearnBankTargetId(slot, param)))"
              @click="learn.clearId(midiLearnBankTargetId(slot, param))"
            >
              ×
            </button>
          </span>
        </div>
        <div v-for="row in bankNavRows" :key="row.id" class="ml-device-row ml-bank-nav-row">
          <span class="ml-device-name" v-tooltip="row.label">{{ row.label }}</span>
          <button
            type="button"
            class="ml-bind ml-bind-bank-nav"
            :class="{ 'ml-bind-armed': learn.isArmedId(row.id) }"
            :aria-pressed="learn.isArmedId(row.id)"
            :disabled="!!learnBlocked"
            v-tooltip="bindTip(learn.isArmedId(row.id))"
            @click="learn.armId(row.id)"
          >
            {{ row.binding ? formatMidiCcBinding(row.binding) : t.shell.midiLearn.learn }}
          </button>
          <button
            type="button"
            class="ml-clear"
            :disabled="!row.binding"
            :aria-label="t.shell.midiLearn.clearBinding"
            v-tooltip="clearTip(!!row.binding)"
            @click="learn.clearId(row.id)"
          >
            ×
          </button>
        </div>
      </div>

      <div class="ml-devices ml-transport">
        <div class="ml-row-head ml-devices-head">
          <span class="ml-col-head">{{ t.shell.midiLearn.transport }}</span>
        </div>
        <div v-for="row in transportRows" :key="row.id" class="ml-device-row ml-transport-row">
          <span class="ml-device-name" v-tooltip="row.label">{{ row.label }}</span>
          <button
            type="button"
            class="ml-bind ml-bind-transport"
            :class="{ 'ml-bind-armed': learn.isArmedId(row.id) }"
            :aria-pressed="learn.isArmedId(row.id)"
            :disabled="!!learnBlocked"
            v-tooltip="bindTip(learn.isArmedId(row.id))"
            @click="learn.armId(row.id)"
          >
            {{ row.binding ? formatMidiCcBinding(row.binding) : t.shell.midiLearn.learn }}
          </button>
          <button
            type="button"
            class="ml-clear"
            :disabled="!row.binding"
            :aria-label="t.shell.midiLearn.clearBinding"
            v-tooltip="clearTip(!!row.binding)"
            @click="learn.clearId(row.id)"
          >
            ×
          </button>
        </div>
      </div>

      <div v-if="deviceBindings.length > 0" class="ml-devices">
        <div class="ml-row-head ml-devices-head">
          <span class="ml-col-head">{{ t.shell.midiLearn.deviceControls }}</span>
        </div>
        <div v-for="row in deviceBindings" :key="row.id" class="ml-device-row">
          <span class="ml-device-name" v-tooltip="row.label">{{ row.label }}</span>
          <span class="ml-device-binding">{{ formatMidiCcBinding(row.binding) }}</span>
          <button
            type="button"
            class="ml-clear"
            :aria-label="t.shell.midiLearn.clearBinding"
            v-tooltip="t.shell.midiLearn.clearBinding"
            @click="learn.clearId(row.id)"
          >
            ×
          </button>
        </div>
      </div>
    </div>

    <footer class="ml-foot">
      <span class="ml-hint">{{ t.shell.midiLearn.hint }}</span>
      <span class="ml-spacer" />
      <button
        type="button"
        class="ml-btn"
        :disabled="!!clearAllBlocked"
        v-tooltip="{ text: t.shell.midiLearn.clearAllButtonTitle, reason: clearAllBlocked }"
        @click="clearAll"
      >
        {{ t.shell.midiLearn.clearAll }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="./midi-learn-panel.css"></style>

<style scoped>
.ml-bank {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--sp-2);
}

.ml-bank-head,
.ml-bank-row {
  grid-template-columns: 1fr repeat(4, 4.5rem);
}

.ml-bank-nav-row {
  margin-top: var(--sp-1);
}

.midi-learn-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--sp-2));
  z-index: 60;
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-family: var(--font-sans);
  color: var(--text-2);
}

.ml-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
}

.ml-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ml-close {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: var(--fs-lg);
  line-height: 1;
  cursor: pointer;
  padding: 0 var(--sp-1);
  transition: color var(--dur-1) var(--ease-out);
}

.ml-close:hover {
  color: var(--text-1);
}

.ml-body {
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) var(--sp-3);
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}

.ml-row {
  display: grid;
  grid-template-columns: 1fr 5.5rem 5.5rem;
  align-items: center;
  gap: var(--sp-2);
}


.ml-name {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-name-master {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ml-swatch {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.ml-cell {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ml-bind {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px var(--sp-1);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-3);
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.ml-bind:hover:not(:disabled) {
  color: var(--text-1);
  box-shadow: var(--control-lift-hover);
}

.ml-bind:disabled {
  color: var(--text-4);
  box-shadow: var(--control-edge);
  cursor: default;
}

.ml-bind:active:not(:disabled) {
  box-shadow: var(--control-edge), var(--inset-well);
}

.ml-bind-set {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: none;
}

.ml-bind-armed {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: none;
}

.ml-devices {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--sp-2);
}


.ml-device-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: var(--sp-2);
}

.ml-device-name {
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-device-binding {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
}

.ml-clear {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font-size: var(--fs-sm);
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  transition: color var(--dur-1) var(--ease-out);
}

.ml-clear:hover:not(:disabled) {
  color: var(--danger-text);
}

/* An empty row keeps its clear slot for alignment but drops out of sight. */
.ml-clear:disabled {
  opacity: 0.35;
  cursor: default;
}


.ml-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.ml-hint {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.ml-spacer {
  flex: 1 1 auto;
}

</style>

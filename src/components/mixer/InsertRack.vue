<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import type { MeterSource } from '@/engine/meters';
import { describeError } from '@/lib/errors';
import {
  assertNoBusRoutingCycle,
  groupBusTopologyId,
  mixerBusTopology,
} from '@/project/bus-topology';
import { cloneJson } from '@/project/clone-json';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import {
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  replaceInsert,
  setInsertSidechain,
} from '@/project/commands';
import {
  createDefaultStrip,
  type InsertSlot,
  type MixerSidechainSource,
  type MixerStrip,
} from '@/project/mixer';
import type { ProcessorControlValue } from '@/project/processor-controls';
import { formatProcessorControlValue } from '@/project/processor-controls';
import { listQuickControls, type QuickControl, setQuickControl } from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatLevel } from '@/ui/mastering/loudness';
import { openContextMenu } from '@/ui/menu/context-menu';
import { midiLearnInsertTargetId } from '@/ui/midi/midi-learn';
import {
  groupInsertCatalogEntries,
  humanizeInsertName,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import { coupledKeyList, insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';
import { type InsertChainKind, insertGainReductionBySlot } from '@/ui/mixer/insert-gain-reduction';
import {
  addInsertSlot,
  adjustExpandedAfterRemove,
  isSidechainKeyedProcessor,
  removeInsertSlot,
  reorderInsertSlots,
  toggleInsertEnabled,
} from '@/ui/mixer/insert-rack';
import { gainReductionFraction } from '@/ui/mixer/master-meter';
import type { SidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
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

/** Chain kind deciding how store slots map to engine inserts. */
const chainKind = computed<InsertChainKind>(() => {
  if (props.target === 'master') return 'master';
  if (isMixerBusStripTarget(props.target)) return 'bus';
  const target = props.target;
  return store.tracks.find((track) => track.id === target)?.kind === 'group' ? 'bus' : 'lane';
});

// --- Per-insert gain reduction -----------------------------------------------

/** Reduction magnitude (dB, 0.1 dB steps) per store slot; undefined when idle. */
const slotGrDb = ref<Array<number | undefined>>([]);
/** Slots that have reduced at least once; only they keep a readout. */
const grSlotKeys = ref(new Set<string>());

function slotKey(slot: InsertSlot, index: number): string {
  return slot.id ?? `${index}:${slot.processor}`;
}

function onInsertGr(valuesDb: readonly number[]): void {
  const inserts = strip.value.inserts;
  const next = insertGainReductionBySlot(chainKind.value, strip.value, valuesDb).map((db) =>
    db === undefined ? undefined : Math.round(db * 10) / 10,
  );
  const current = slotGrDb.value;
  if (next.length === current.length && next.every((db, i) => db === current[i])) return;
  slotGrDb.value = next;
  next.forEach((db, i) => {
    const slot = inserts[i];
    if (db === undefined || !slot) return;
    const key = slotKey(slot, i);
    if (!grSlotKeys.value.has(key)) grSlotKeys.value = new Set(grSlotKeys.value).add(key);
  });
}

function hasGrReadout(slot: InsertSlot, index: number): boolean {
  return grSlotKeys.value.has(slotKey(slot, index));
}

function grLabel(index: number): string {
  const db = slotGrDb.value[index];
  return db === undefined ? '0.0' : `-${formatLevel(db)}`;
}

function grFraction(index: number): number {
  const db = slotGrDb.value[index];
  return db === undefined ? 0 : gainReductionFraction(db);
}

let unsubscribeGr: (() => void) | null = null;

watch(
  () => [props.meter, props.visible] as const,
  ([meter, visible]) => {
    unsubscribeGr?.();
    unsubscribeGr = null;
    slotGrDb.value = [];
    if (meter && visible) unsubscribeGr = meter.subscribeInsertGainReduction(onInsertGr);
  },
  { immediate: true },
);

/** Surfaced when a command rejects (e.g. unknown processor at apply time). */
const error = ref('');

/** Process-local insert clipboard; copied settings are detached from the source slot. */
let insertClipboard: Omit<InsertSlot, 'id'> | null = null;

// --- Expand / parameter knobs ------------------------------------------------

const expandedIndex = ref<number | null>(null);

const expandedControls = computed<QuickControl[]>(() => {
  const index = expandedIndex.value;
  if (index === null || index >= strip.value.inserts.length) return [];
  try {
    return listQuickControls({ type: 'insert', trackId: props.target, index });
  } catch {
    return [];
  }
});

function toggleExpanded(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

/** In-flight knob gestures keyed by control id (one per dragged knob). */
const gestures = new Map<string, ValueGesture>();

function onParamChange(control: QuickControl, value: ProcessorControlValue, commit: boolean): void {
  const index = expandedIndex.value;
  if (index === null) return;
  const apply = (v: number, options: CommandGestureOptions): void => {
    setQuickControl({ type: 'insert', trackId: props.target, index }, control.id, v, options);
  };
  try {
    if (control.kind !== 'number') {
      // Toggles and enum selections are atomic edits; only number knobs need a
      // coalesced gesture map.
      setQuickControl({ type: 'insert', trackId: props.target, index }, control.id, value, {
        commit: true,
      });
      error.value = '';
      return;
    }
    if (!commit) {
      let gesture = gestures.get(control.id);
      if (!gesture) {
        gesture = createValueGesture(apply, control.value);
        gestures.set(control.id, gesture);
      }
      gesture.update(value as number);
    } else {
      const gesture = gestures.get(control.id);
      if (gesture) gesture.end(value as number);
      else apply(value as number, { commit: true });
      gestures.delete(control.id);
    }
    error.value = '';
  } catch (err) {
    error.value = insertEditErrorMessage(err, t.value);
  }
}

/** Tooltip remark for a knob whose accepted range moves with sibling keys. */
function coupledNote(control: QuickControl): string {
  if (control.kind !== 'number' || !control.coupledWith) return '';
  return formatMessage(t.value.shell.mixer.controls.coupledNote, {
    related: coupledKeyList(control.coupledWith),
  });
}

/** Formatted knob value with the control's unit. */
function onBooleanToggle(control: Extract<QuickControl, { kind: 'boolean' }>): void {
  onParamChange(control, !control.value, true);
}

function onEnumChange(
  control: Extract<QuickControl, { kind: 'enum' }>,
  value: string | number,
): void {
  onParamChange(control, value, true);
}

// --- MIDI learn (shared app handle, injected; null in isolated tests) --------

const midiLearn = inject(MIDI_LEARN_KEY, null);

/** Learn target id for a control on the currently expanded insert slot. */
function learnTargetId(control: QuickControl): string {
  if (isMixerBusStripTarget(props.target)) return '';
  const index = expandedIndex.value ?? -1;
  return midiLearnInsertTargetId(props.target, strip.value.inserts[index]?.id ?? index, control.id);
}

/** MIDI-learn state for a control's knob menu, or undefined when unavailable. */
function learnState(control: QuickControl): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn || isMixerBusStripTarget(props.target)) return undefined;
  const id = learnTargetId(control);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearn(control: QuickControl): void {
  if (isMixerBusStripTarget(props.target)) return;
  midiLearn?.armId(learnTargetId(control));
}

function onMidiForget(control: QuickControl): void {
  if (isMixerBusStripTarget(props.target)) return;
  midiLearn?.clearId(learnTargetId(control));
}

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

function copySlot(index: number): void {
  const slot = strip.value.inserts[index];
  if (!slot) return;
  const { id: _id, ...copy } = slot;
  insertClipboard = cloneJson(copy);
}

function pasteSlot(index: number): void {
  if (!insertClipboard) return;
  try {
    replaceInsert(props.target, index, insertClipboard);
    expandedIndex.value = index;
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

function onSlotContextMenu(index: number, event: MouseEvent): void {
  openContextMenu(event.clientX, event.clientY, [
    { id: 'copy-insert', label: t.value.shell.inserts.copy, run: () => copySlot(index) },
    {
      id: 'paste-insert',
      label: t.value.shell.inserts.paste,
      disabledReason: firstBlock([
        insertClipboard === null,
        t.value.shell.mixer.reasons.noInsertCopied,
      ]),
      run: () => pasteSlot(index),
    },
  ]);
}

// --- Drag reorder ------------------------------------------------------------

const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragIndex.value === null) return;
  event.preventDefault();
  dragOverIndex.value = index;
}

function onDrop(index: number): void {
  const from = dragIndex.value;
  dragIndex.value = null;
  dragOverIndex.value = null;
  if (from === null || from === index) return;
  try {
    reorderInsertSlots(props.target, strip.value.inserts, from, index);
    expandedIndex.value = null;
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

// --- Sidechain key source ------------------------------------------------------

/** String values keep track, group and return-bus id namespaces unambiguous. */
type SidechainSourceValue = 'none' | `track:${number}` | `group:${number}` | `bus:${string}`;
const SIDECHAIN_NONE: SidechainSourceValue = 'none';

/** Ordinary track strips accept track keys only; bus/group keys target bus nodes. */
const ordinaryTrackTarget = computed(() => {
  if (typeof props.target !== 'number') return false;
  return store.tracks.find((track) => track.id === props.target)?.kind !== 'group';
});

/** The bus node receiving a bus/group sidechain dependency, when one exists. */
const sidechainTargetBusId = computed<string | null>(() => {
  const target = props.target;
  if (isMixerBusStripTarget(target)) return mixerBusIdFromTarget(target);
  if (typeof target !== 'number') return null;
  const track = store.tracks.find((entry) => entry.id === target);
  return track?.kind === 'group' ? groupBusTopologyId(track.id) : null;
});

function isSidechainNodeAllowed(sourceNodeId: string): boolean {
  const targetNodeId = sidechainTargetBusId.value;
  if (targetNodeId === null) return true;
  if (targetNodeId === sourceNodeId) return false;
  try {
    assertNoBusRoutingCycle(
      mixerBusTopology(
        store.mixer,
        store.tracks
          .filter((track) => track.kind === 'group')
          .map((track) => ({ id: track.id, mixer: track.mixer })),
      ),
      sourceNodeId,
      targetNodeId,
    );
    return true;
  } catch {
    return false;
  }
}

/** A return-bus key source must not point at itself or close a bus cycle. */
function isSidechainBusSourceAllowed(busId: string): boolean {
  return isSidechainNodeAllowed(busId);
}

/** A group-bus key source follows the same topology rules as a return bus. */
function isSidechainGroupSourceAllowed(trackId: number): boolean {
  return isSidechainNodeAllowed(groupBusTopologyId(trackId));
}

/** Key-source options: no key, tracks, group buses and return buses. */
const storeSidechainOptions = computed<
  { value: SidechainSourceValue; label: string; disabled?: boolean }[]
>(() => [
  { value: SIDECHAIN_NONE, label: t.value.shell.inserts.noKey },
  ...store.tracks
    .filter(
      (track) =>
        track.id !== props.target && !(ordinaryTrackTarget.value && track.kind === 'group'),
    )
    .map((track) => {
      const groupSource = track.kind === 'group' && !ordinaryTrackTarget.value;
      return {
        value: (groupSource ? `group:${track.id}` : `track:${track.id}`) as SidechainSourceValue,
        label:
          track.kind === 'group'
            ? `${track.name} · ${t.value.shell.mixer.strip.group}`
            : track.name,
        ...(groupSource ? { disabled: !isSidechainGroupSourceAllowed(track.id) } : {}),
      };
    }),
  ...(ordinaryTrackTarget.value
    ? []
    : store.mixer.buses.map((bus) => ({
        value: `bus:${bus.id}` as SidechainSourceValue,
        label: `${bus.name} · ${t.value.shell.mixer.strip.bus}`,
        disabled: !isSidechainBusSourceAllowed(bus.id),
      }))),
]);

/**
 * Bumped when the key picker is about to open: the engine's answer is not
 * reactive, so it is re-read against the engine state at that moment.
 */
const sidechainCheckEpoch = ref(0);

function refreshSidechainChecks(): void {
  sidechainCheckEpoch.value += 1;
}

/** Store options for the expanded slot, with engine refusals disabled and explained. */
const sidechainOptions = computed<
  { value: SidechainSourceValue; label: string; detail?: string; disabled?: boolean }[]
>(() => {
  void sidechainCheckEpoch.value;
  const lookup = props.sidechainRefusal;
  const index = expandedIndex.value;
  if (!lookup || index === null) return storeSidechainOptions.value;
  return storeSidechainOptions.value.map((option) => {
    if (option.value === 'none' || option.disabled) return option;
    const reason = lookup(props.target, index, sidechainSourceFromValue(option.value));
    if (reason === null) return option;
    return { ...option, disabled: true, detail: t.value.shell.inserts.sidechainRefusal[reason] };
  });
});

function sidechainSourceFromValue(
  value: Exclude<SidechainSourceValue, 'none'>,
): MixerSidechainSource {
  if (value.startsWith('track:')) {
    return { kind: 'track', trackId: Number(value.slice('track:'.length)) };
  }
  if (value.startsWith('group:')) {
    return { kind: 'group', trackId: Number(value.slice('group:'.length)) };
  }
  return { kind: 'bus', busId: value.slice('bus:'.length) };
}

function sidechainValue(slot: InsertSlot): SidechainSourceValue {
  if (slot.sidechainSourceBusId !== undefined) return `bus:${slot.sidechainSourceBusId}`;
  if (slot.sidechainSourceGroupTrackId !== undefined) {
    return ordinaryTrackTarget.value
      ? `track:${slot.sidechainSourceGroupTrackId}`
      : `group:${slot.sidechainSourceGroupTrackId}`;
  }
  if (slot.sidechainSourceTrackId !== undefined) return `track:${slot.sidechainSourceTrackId}`;
  return SIDECHAIN_NONE;
}

/** True when the slot gets a key-source select (all engine strip targets). */
function hasSidechainSelect(slot: InsertSlot): boolean {
  return isSidechainKeyedProcessor(slot.processor);
}

function onSidechainChange(index: number, value: SidechainSourceValue): void {
  try {
    const source = value === 'none' ? null : sidechainSourceFromValue(value);
    setInsertSidechain(props.target, index, source);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

// --- Add popover ---------------------------------------------------------------

const addMenuOpen = ref(false);
const addMenu = ref<HTMLDivElement | null>(null);
const catalog = ref<InsertCatalogGroup[]>([]);

function openAddMenu(): void {
  if (!addMenuOpen.value) {
    // Loaded lazily: the wasm catalog may not exist at mount time. Mixer
    // strips run inserts in the realtime engine, so offer only the
    // insert-safe subset (the engine rejects offline-only processors).
    catalog.value = groupInsertCatalogEntries(loadInsertCatalogEntries('realtime'));
  }
  addMenuOpen.value = !addMenuOpen.value;
}

function onAddProcessor(processorId: string): void {
  addMenuOpen.value = false;
  try {
    const index = addInsertSlot(props.target, processorId);
    expandedIndex.value = index;
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

useOutsidePointerDown(
  addMenuOpen,
  (target) => !!addMenu.value?.contains(target),
  () => {
    addMenuOpen.value = false;
  },
);

onBeforeUnmount(() => {
  unsubscribeGr?.();
  unsubscribeGr = null;
  for (const gesture of gestures.values()) gesture.end();
  gestures.clear();
});
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
    <div ref="addMenu" class="insert-add-wrap">
      <button
        type="button"
        class="insert-add"
        v-tooltip="t.shell.inserts.add"
        aria-haspopup="menu"
        :aria-expanded="addMenuOpen"
        @click="openAddMenu"
      >
        {{ t.shell.inserts.addButton }}
      </button>
      <Transition name="pop">
      <div v-if="addMenuOpen" class="insert-catalog" role="menu">
        <div v-for="group in catalog" :key="group.category" class="catalog-group">
          <div class="catalog-category">{{ group.label }}</div>
          <button
            v-for="processor in group.processors"
            :key="processor.id"
            type="button"
            role="menuitem"
            class="catalog-item"
            @click="onAddProcessor(processor.id)"
          >
            <span class="catalog-item-label">{{ processor.label }}</span>
            <span v-if="processor.stereoOnly" class="catalog-item-tag">{{
              t.shell.inserts.stereoOnly
            }}</span>
          </button>
        </div>
      </div>
      </Transition>
    </div>
    <p v-if="error" class="insert-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.insert-rack {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.insert-slot {
  position: relative;
  display: flex;
  align-items: center;
  gap: 3px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 3px;
  /* Index-keyed rows: only a newly appended slot mounts, so only it animates. */
  animation: view-enter var(--dur-2) var(--ease-out);
}

/* Explicit landing line above the hovered slot during a reorder drag. */
.insert-slot.drag-over::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -2px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}

.insert-slot.bypassed .insert-name {
  color: var(--text-4);
}

.insert-drag {
  flex: none;
  color: var(--text-4);
  font-size: var(--fs-chrome-lg);
  line-height: 1;
  letter-spacing: -1px;
  cursor: grab;
  user-select: none;
}

.insert-drag:active {
  cursor: grabbing;
}

.insert-power {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: none;
  background: var(--surface-3);
  box-shadow: var(--control-edge);
  padding: 0;
  cursor: pointer;
  transition:
    background var(--dur-2) var(--ease-out),
    box-shadow var(--dur-2) var(--ease-out);
}

.insert-power.on {
  background: var(--success);
  --latch-from: 0.6;
  animation: toggle-latch var(--dur-3) var(--ease-spring);
}

.insert-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 1px 0;
  cursor: pointer;
  transition: color var(--dur-2) var(--ease-out);
}

.insert-name.expanded {
  color: var(--accent);
}

.insert-gr {
  flex: none;
  min-width: 3.5ch;
  text-align: right;
  font: var(--fs-chrome-md) var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-4);
}

.insert-gr.active {
  color: var(--text-2);
}

/* Hairline reduction bar on the slot's bottom edge, right-anchored like StripGrMeter. */
.insert-gr-bar {
  position: absolute;
  left: 3px;
  right: 3px;
  bottom: 0;
  height: 2px;
  pointer-events: none;
}

.insert-gr-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  border-radius: 1px;
  background: var(--meter-yellow);
}

.insert-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: var(--fs-2xs) var(--font-sans);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.insert-remove:hover {
  color: var(--danger-text);
}

.insert-params {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-3);
  justify-content: center;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: var(--sp-2) var(--sp-1);
  box-shadow: var(--inset-well);
  /* Opacity only: a transform here would re-anchor the knobs' fixed menus. */
  animation: insert-params-in var(--dur-2) var(--ease-out);
}

@keyframes insert-params-in {
  from {
    opacity: 0;
  }
}

.insert-param-toggle {
  min-width: 44px;
  min-height: 28px;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-3);
  background: var(--control-bg);
  box-shadow: var(--control-lift);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  cursor: pointer;
  transition:
    background var(--dur-2) var(--ease-out),
    color var(--dur-2) var(--ease-out);
}

.insert-param-toggle.on {
  color: var(--text-1);
  background: var(--accent-muted);
}

.insert-param-value {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.insert-param-label {
  max-width: 74px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-4);
  font: var(--fs-chrome-md) var(--font-sans);
  text-transform: uppercase;
}

.insert-param-select {
  min-width: 100px;
}

.insert-param-midi {
  display: flex;
  align-items: center;
  gap: 2px;
}

.insert-param-midi-learn,
.insert-param-midi-forget {
  flex: none;
  height: 14px;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-4);
  background: var(--surface-3);
  font: var(--fs-chrome-sm) var(--font-sans);
  line-height: 1;
  padding: 0 3px;
  cursor: pointer;
}

/* Listening for a MIDI message: a breathing halo until a control arrives. */
.insert-param-midi-learn.armed {
  --live-color: var(--accent);
  color: var(--accent);
  border-color: var(--accent);
  animation: live-glow 1.8s var(--ease-out) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .insert-param-midi-learn.armed {
    animation: none;
  }
}

.insert-param-midi-learn.bound {
  color: var(--success);
  border-color: var(--success);
}

.insert-param-midi-forget {
  width: 14px;
  padding: 0;
}

.insert-add-wrap {
  position: relative;
}

.insert-add {
  width: 100%;
  font: var(--fw-semibold) var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-3);
  background: transparent;
  box-shadow: none;
  border-radius: 3px;
  padding: 2px 0;
  cursor: pointer;
  transition: color var(--dur-1) var(--ease-out);
}

.insert-add:hover {
  color: var(--text-2);
}

.insert-catalog {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 30;
  width: 150px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 2px 0;
  transform-origin: top left;
}

.catalog-category {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-4);
  padding: 4px 8px 2px;
}

.catalog-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 3px 10px;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.catalog-item:hover {
  background: var(--surface-4);
}

.catalog-item-tag {
  flex: none;
  font: var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 4px;
}

.insert-error {
  margin: 0;
  font: var(--fs-chrome-lg)/1.3 var(--font-sans);
  color: var(--danger-text);
}
.insert-sidechain {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
}

.insert-sidechain-label {
  font-size: var(--fs-chrome-lg);
  color: var(--text-3);
  text-transform: uppercase;
}

.insert-sidechain-select {
  flex: 1;
  min-width: 0;
}
</style>

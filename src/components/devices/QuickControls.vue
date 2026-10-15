<script setup lang="ts">
import { computed, inject, onBeforeUnmount, reactive, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import {
  type AutomationParam,
  type AutomationTarget,
  busAutomationTarget,
  insertAutomationParam,
  instrumentAutomationParam,
} from '@/project/automation';
import {
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  removeAutomationLane,
  setAutomationLanePoints,
} from '@/project/commands';
import { isAutomatableSynthParam } from '@/project/instrument';
import type { NumberProcessorControl, ProcessorControlValue } from '@/project/processor-controls';
import { formatProcessorControlValue, isConstructionOnlyParam } from '@/project/processor-controls';
import {
  isAmpConstructionOnlyParam,
  listQuickControls,
  type QuickControl,
  type QuickControlResolvers,
  type QuickControlTarget,
  setQuickControl,
} from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import {
  controlPercent,
  knobRotationDeg,
  knobValueForDrag,
  valueAtControlPercent,
} from '@/ui/devices/knob-math';
import { formatMessage, useI18n } from '@/ui/i18n';
import { midiLearnInsertTargetId, midiLearnInstrumentTargetId } from '@/ui/midi/midi-learn';
import {
  type AutomationWriteGesture,
  type AutomationWriteMode,
  type AutomationWriteScheduleEvent,
  automationStripMode,
  createAutomationWriteGesture,
  isAutomationWriteMode,
} from '@/ui/mixer/automation-mode';
import { coupledKeyList, insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';

/**
 * Quick Controls for the selected device (instrument or insert slot). Knob
 * values come from the pure quick-control listing over the store mirror;
 * drags apply live values through setQuickControl with gesture coalescing, so
 * one knob drag lands as a single undo entry.
 */

const props = defineProps<{
  /** Device the knobs address (instrument or insert slot). */
  target: QuickControlTarget;
  /** Optional catalog resolvers (tests, custom catalogs). */
  resolvers?: QuickControlResolvers;
  /**
   * Playhead position getter in PPQ. Present enables touch-recording a knob
   * into automation when its strip is in a write (touch/latch) mode.
   */
  positionPpq?: () => number;
  /** Current playhead sample position, used by future sample-accurate scheduling. */
  positionSample?: () => number;
  /** True while the transport runs (continuous touch recording). */
  isPlaying?: boolean;
  /** Optional realtime automation scheduler for write-mode knob drags. */
  scheduleAutomationWrite?: (
    target: AutomationTarget,
    param: AutomationParam,
    event: AutomationWriteScheduleEvent,
  ) => void;
}>();

const { t } = useI18n();
const store = useProjectStore();
/** Surfaced when a control edit rejects. */
const error = ref('');

const controls = computed<QuickControl[]>(() => {
  try {
    return listQuickControls(props.target, props.resolvers);
  } catch {
    return [];
  }
});

/** Applies one control value through the undoable command layer. */
function apply(id: string, value: ProcessorControlValue, commit: boolean): void {
  try {
    setQuickControl(props.target, id, value, { commit });
    error.value = '';
  } catch (err) {
    error.value = insertEditErrorMessage(err, t.value);
  }
}

// --- Knob touch recording -----------------------------------------------------

/** Automation target of the device: its track for an instrument, else its strip. */
const automationTarget = computed<AutomationTarget | null>(() => {
  if (props.target.type === 'instrument') return props.target.trackId;
  const strip = props.target.trackId;
  if (strip === 'master') return 'master';
  if (typeof strip === 'number') return strip;
  if (isMixerBusStripTarget(strip)) return busAutomationTarget(mixerBusIdFromTarget(strip));
  return null;
});

/** Automation param token for a control, or null when the control has no lane. */
function automationParamToken(controlId: string): AutomationParam | null {
  if (props.target.type === 'instrument') {
    return isAutomatableSynthParam(controlId) ? instrumentAutomationParam(controlId) : null;
  }
  const stripTarget = props.target.trackId;
  const strip =
    stripTarget === 'master'
      ? store.mixer.master
      : typeof stripTarget === 'number'
        ? store.tracks.find((track) => track.id === stripTarget)?.mixer
        : store.mixer.buses.find((bus) => bus.id === mixerBusIdFromTarget(stripTarget))?.strip;
  const slot = strip?.inserts[props.target.index];
  // A construction-only key has no engine id: a lane for it would be inert, so
  // the drag falls through to the parameter edit instead.
  if (
    !slot ||
    isConstructionOnlyParam(slot.processor, controlId) ||
    isAmpConstructionOnlyParam(slot.processor, controlId)
  ) {
    return null;
  }
  return insertAutomationParam(slot.id ?? props.target.index, controlId);
}

/** Write context decided when a write-mode knob drag begins. */
interface KnobWriteContext {
  mode: AutomationWriteMode;
  target: AutomationTarget;
  param: AutomationParam;
}

/** Resolves the touch-record context for a control, or null (not recording). */
function writeContextFor(control: QuickControl): KnobWriteContext | null {
  if (control.kind !== 'number') return null;
  if (props.positionPpq === undefined) return null;
  const target = automationTarget.value;
  const param = automationParamToken(control.id);
  if (target === null || param === null) return null;
  const mode = automationStripMode(target);
  if (!isAutomationWriteMode(mode)) return null;
  return { mode, target, param };
}

/** Set for the dragged knob while it touch-records (null in manual modes). */
let writeContext: KnobWriteContext | null = null;
let writeGesture: AutomationWriteGesture | null = null;
/** Live value shown on the knob being touch-recorded (id + value), or null. */
const writeValue = ref<{ id: string; value: number } | null>(null);

/** Knob value shown: the live write drag for that knob, else the store value. */
function shownValue(control: NumberProcessorControl): number {
  return writeValue.value?.id === control.id ? writeValue.value.value : control.value;
}

/** Feeds a write-mode drag value into the lane gesture (lazily started). */
function recordWrite(controlId: string, value: number): void {
  const ctx = writeContext;
  if (!ctx) return;
  if (!writeGesture) {
    const lane = store.automationLanes.find(
      (entry) => entry.target === ctx.target && entry.param === ctx.param,
    );
    writeGesture = createAutomationWriteGesture({
      mode: ctx.mode,
      existingPoints: lane?.points ?? [],
      positionPpq: () => Math.max(0, props.positionPpq?.() ?? 0),
      positionSample: props.positionSample,
      isPlaying: () => props.isPlaying === true,
      schedule: (event) => props.scheduleAutomationWrite?.(ctx.target, ctx.param, event),
      commit: (points) => setAutomationLanePoints(ctx.target, ctx.param, points),
    });
  }
  writeGesture.update(value);
  writeValue.value = { id: controlId, value };
}

/** Closes any in-flight write gesture, committing its recorded points. */
function endWrite(): void {
  writeGesture?.end();
  writeGesture = null;
  writeContext = null;
  writeValue.value = null;
}

// --- Knob dragging -----------------------------------------------------------

interface KnobDrag {
  id: string;
  pointerId: number;
  startY: number;
  startValue: number;
  lastValue: number;
  min: number;
  max: number;
  scale: 'linear' | 'log';
  moved: boolean;
}

const drag = ref<KnobDrag | null>(null);

function onKnobPointerDown(control: NumberProcessorControl, event: PointerEvent): void {
  if (event.button !== 0) return;
  const el = event.currentTarget as HTMLElement;
  if (typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId);
  drag.value = {
    id: control.id,
    pointerId: event.pointerId,
    startY: event.clientY,
    startValue: control.value,
    lastValue: control.value,
    min: control.min,
    max: control.max,
    scale: control.scale ?? 'linear',
    moved: false,
  };
  // A write-mode strip turns this drag into a touch-recording of the lane
  // instead of a manual parameter edit; null keeps the manual command path.
  writeContext = writeContextFor(control);
}

function onKnobPointerMove(event: PointerEvent): void {
  const active = drag.value;
  if (!active || event.pointerId !== active.pointerId) return;
  const value = knobValueForDrag(
    active.startValue,
    event.clientY - active.startY,
    active.min,
    active.max,
    event.shiftKey,
    active.scale,
  );
  if (value === active.lastValue) return;
  drag.value = { ...active, lastValue: value, moved: true };
  if (writeContext) recordWrite(active.id, value);
  else apply(active.id, value, false);
}

function onKnobPointerUp(event: PointerEvent): void {
  const active = drag.value;
  if (!active || event.pointerId !== active.pointerId) return;
  drag.value = null;
  // A write-mode drag commits its recorded points (a click without movement
  // opened no gesture and records nothing).
  if (writeGesture || writeContext) {
    endWrite();
    return;
  }
  // Closing the gesture with the final value lands the drag as one history
  // entry; a click without movement opened no gesture and commits a no-op.
  if (active.moved) apply(active.id, active.lastValue, true);
}

function onKnobPointerCancel(event: PointerEvent): void {
  onKnobPointerUp(event);
}

// --- Keyboard adjustment -----------------------------------------------------

/** Fraction of the range one arrow-key step moves. */
const KEY_STEP_FRACTION = 0.02;

function onKnobKeydown(control: NumberProcessorControl, event: KeyboardEvent): void {
  let direction = 0;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') direction = 1;
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') direction = -1;
  else return;
  event.preventDefault();
  const scale = event.shiftKey ? KEY_STEP_FRACTION / 10 : KEY_STEP_FRACTION;
  const next = valueAtControlPercent(
    controlPercent(control.value, control.min, control.max, control.scale) + direction * scale,
    control.min,
    control.max,
    control.scale,
  );
  if (next !== control.value) apply(control.id, next, true);
}

// --- MIDI learn (shared app handle, injected; null in isolated tests) --------

const midiLearn = inject(MIDI_LEARN_KEY, null);

/** Right-click learn menu state (one menu shared across the knobs). */
const menu = reactive<{ open: boolean; x: number; y: number; controlId: string }>({
  open: false,
  x: 0,
  y: 0,
  controlId: '',
});

/** Learn target id for a control on the current device target. */
function learnTargetId(controlId: string): string {
  if (props.target.type === 'instrument') {
    return midiLearnInstrumentTargetId(props.target.trackId, controlId);
  }
  if (isMixerBusStripTarget(props.target.trackId)) return '';
  const strip =
    props.target.trackId === 'master'
      ? store.mixer.master
      : store.tracks.find((track) => track.id === props.target.trackId)?.mixer;
  return midiLearnInsertTargetId(
    props.target.trackId,
    strip?.inserts[props.target.index]?.id ?? props.target.index,
    controlId,
  );
}

/** MIDI-learn state for a control, or undefined when the handle is absent. */
function learnState(controlId: string): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn) return undefined;
  const id = learnTargetId(controlId);
  if (id === '') return undefined;
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

/** Closes the menu on any press outside of it. */
function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('.qc-menu')) closeMenu();
}

function closeMenu(): void {
  if (!menu.open) return;
  menu.open = false;
  window.removeEventListener('pointerdown', onOutsidePointerDown, true);
}

function onKnobContextMenu(control: QuickControl, event: MouseEvent): void {
  // Open when the knob has at least one menu action: MIDI learn (when a handle
  // is injected and the target is mappable) or automation (a knob with a lane).
  const midiAvailable = midiLearn !== null && learnTargetId(control.id) !== '';
  const automateAvailable =
    control.kind === 'number' &&
    automationTarget.value !== null &&
    automationParamToken(control.id) !== null;
  if (!midiAvailable && !automateAvailable) return;
  event.preventDefault();
  menu.open = true;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.controlId = control.id;
  window.addEventListener('pointerdown', onOutsidePointerDown, true);
}

/** Existing automation lane for a control, or undefined. */
function automationLaneFor(controlId: string) {
  const target = automationTarget.value;
  const param = automationParamToken(controlId);
  if (target === null || param === null) return undefined;
  return store.automationLanes.find((lane) => lane.target === target && lane.param === param);
}

/** Creates or removes the automation lane for the menu's control. */
function onToggleAutomation(): void {
  const target = automationTarget.value;
  const param = automationParamToken(menu.controlId);
  if (target !== null && param !== null) {
    if (automationLaneFor(menu.controlId)) {
      removeAutomationLane(target, param);
    } else {
      // Seed a breakpoint holding the current value so the lane exists and is
      // selectable; further points come from drawing or touch recording.
      const control = controls.value.find((entry) => entry.id === menu.controlId);
      if (control?.kind === 'number') {
        setAutomationLanePoints(target, param, [{ ppq: 0, value: control.value }]);
      }
    }
  }
  closeMenu();
}

/** Whether the current menu target can be written to a numeric automation lane. */
function menuControlIsNumeric(): boolean {
  return controls.value.find((control) => control.id === menu.controlId)?.kind === 'number';
}

/** Tooltip remark for a knob whose accepted range moves with sibling keys. */
function coupledNote(control: QuickControl): string {
  if (control.kind !== 'number' || !control.coupledWith) return '';
  return formatMessage(t.value.shell.mixer.controls.coupledNote, {
    related: coupledKeyList(control.coupledWith),
  });
}

/** Control title with its current value, plus the coupled-key remark when one applies. */
function controlTooltip(control: QuickControl): string {
  const title = formatMessage(t.value.shell.devicesPanel.quickControlTitle, {
    name: control.name,
    value: controlDisplay(control),
  });
  const note = coupledNote(control);
  return note ? `${title} — ${note}` : title;
}

function onBooleanToggle(control: Extract<QuickControl, { kind: 'boolean' }>): void {
  apply(control.id, !control.value, true);
}

function onEnumChange(
  control: Extract<QuickControl, { kind: 'enum' }>,
  value: string | number,
): void {
  apply(control.id, value, true);
}

function controlDisplay(control: QuickControl): string {
  return control.kind === 'number'
    ? formatProcessorControlValue({ ...control, value: shownValue(control) })
    : formatProcessorControlValue(control);
}

function onMidiLearn(): void {
  const id = learnTargetId(menu.controlId);
  if (id !== '') midiLearn?.armId(id);
  closeMenu();
}

function onMidiForget(): void {
  const id = learnTargetId(menu.controlId);
  if (id !== '') midiLearn?.clearId(id);
  closeMenu();
}

onBeforeUnmount(() => {
  closeMenu();
  // Commit any in-flight touch recording so its points are not lost.
  endWrite();
});
</script>

<template>
  <div class="quick-controls" :aria-label="t.shell.devicesPanel.quickControls">
    <p v-if="error" class="qc-error" role="alert">{{ error }}</p>
    <EmptyState
      v-if="controls.length === 0"
      variant="inline"
      :message="t.shell.devicesPanel.noControls"
    />
    <div v-else class="qc-grid">
      <div v-for="control in controls" :key="control.id" class="qc-cell">
        <div
          class="qc-control"
          :class="{
            'qc-knob-armed': learnState(control.id) === 'armed',
            'qc-knob-bound': learnState(control.id) === 'bound',
            'qc-control-number': control.kind === 'number',
            'qc-control-boolean': control.kind === 'boolean',
            'qc-control-enum': control.kind === 'enum',
          }"
          :data-control="control.kind === 'number' ? undefined : control.id"
          :aria-label="control.name"
          v-tooltip="controlTooltip(control)"
          @contextmenu="onKnobContextMenu(control, $event)"
        >
          <div v-if="control.kind === 'number'" class="qc-knob" role="slider" tabindex="0"
            :data-control="control.id" :aria-label="control.name"
            :aria-valuemin="control.min" :aria-valuemax="control.max" :aria-valuenow="shownValue(control)"
            @pointerdown="onKnobPointerDown(control, $event)" @pointermove="onKnobPointerMove"
            @pointerup="onKnobPointerUp" @pointercancel="onKnobPointerCancel"
            @keydown="onKnobKeydown(control, $event)">
            <div class="qc-knob-indicator" :style="{
              transform: `rotate(${knobRotationDeg(shownValue(control), control.min, control.max, control.scale)}deg)`,
            }" />
          </div>
          <button
            v-else-if="control.kind === 'boolean'"
            type="button"
            class="qc-toggle"
            :class="{ on: control.value }"
            :aria-pressed="control.value"
            :aria-label="control.name"
            @click="onBooleanToggle(control)"
          >
            {{ control.value ? t.shell.devicesPanel.toggleOn : t.shell.devicesPanel.toggleOff }}
          </button>
          <SelectMenu
            v-else
            class="qc-select"
            :model-value="control.value"
            :options="control.options"
            :aria-label="control.name"
            size="sm"
            @change="(value) => onEnumChange(control, value)"
          />
        </div>
        <span class="qc-name" v-tooltip="control.name">{{ control.name }}</span>
        <span class="qc-value">{{ controlDisplay(control) }}</span>
      </div>
    </div>
    <Transition name="pop">
    <div
      v-if="menu.open"
      class="qc-menu control-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
    >
      <button
        v-if="
          automationTarget !== null &&
          automationParamToken(menu.controlId) !== null &&
          menuControlIsNumeric()
        "
        type="button"
        role="menuitem"
        @click="onToggleAutomation"
      >
        {{
          automationLaneFor(menu.controlId)
            ? t.shell.mixer.controls.removeAutomation
            : t.shell.mixer.controls.automateParam
        }}
      </button>
      <button
        v-if="learnState(menu.controlId) !== undefined"
        type="button"
        role="menuitem"
        :class="{ 'qc-menu-armed': learnState(menu.controlId) === 'armed' }"
        @click="onMidiLearn"
      >
        {{
          learnState(menu.controlId) === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        }}
      </button>
      <button
        v-if="learnState(menu.controlId) === 'bound'"
        type="button"
        role="menuitem"
        @click="onMidiForget"
      >
        {{ t.shell.mixer.controls.midiForget }}
      </button>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.quick-controls {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.qc-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  background: var(--danger-surface);
  color: var(--danger-text);
  font: var(--fs-2xs)/1.4 var(--font-sans);
  border-radius: var(--radius-xs);
}

.qc-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-4) var(--sp-2);
  padding: var(--sp-3) var(--sp-1);
}

.qc-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.qc-control {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 34px;
}

.qc-knob {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-full);
  /* Theme-aware raised knob well: lighter highlight at the top, recessed face. */
  background: radial-gradient(circle at 35% 30%, var(--surface-4), var(--surface-3) 70%);
  box-shadow: var(--control-edge), var(--inset-well);
  cursor: ns-resize;
  touch-action: none;
}

.qc-knob:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.qc-knob-indicator {
  position: absolute;
  inset: 0;
}

.qc-knob-indicator::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 3px;
  width: 2px;
  height: 11px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
}

.qc-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--fw-semibold) var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.qc-value {
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.qc-knob-bound {
  box-shadow: inset 0 0 0 1px var(--accent-muted), var(--inset-well);
}

/* Listening for a MIDI message: the ring breathes until a control arrives. */
.qc-knob-armed {
  box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 1px var(--accent);
  animation: qc-listen 1.8s var(--ease-out) infinite;
}

@keyframes qc-listen {
  50% {
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .qc-knob-armed {
    animation: none;
  }
}

.qc-toggle {
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

.qc-toggle.on {
  color: var(--text-1);
  background: var(--accent-muted);
}

.qc-toggle:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.qc-select {
  width: 100%;
  max-width: 116px;
}

/* Positioning only; the shared .control-menu primitive supplies the glass face. */
.qc-menu {
  z-index: 60;
}

.qc-menu-armed {
  color: var(--accent);
}
</style>

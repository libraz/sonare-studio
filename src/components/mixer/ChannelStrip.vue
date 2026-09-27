<script setup lang="ts">
import { computed, inject, onBeforeUnmount } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { promptDialog } from '@/composables/useDialogs';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { AnalyserBridge } from '@/engine/analyser';
import type { MeterSource } from '@/engine/meters';
import type { ScopeSource } from '@/engine/scope';
import type { AutomationParam } from '@/project/automation';
import {
  addVcaGroup,
  renameTrack,
  setActiveTrack,
  setExclusiveTrackSolo,
  setStripGain,
  setStripOutputBus,
  setStripPan,
  setTrackMute,
  setTrackSolo,
  setTrackSoloSafe,
  setTrackVca,
} from '@/project/commands';
import { createDefaultStrip, MAX_VCA_GROUPS, type MixerStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { type MidiLearnTrackStateParam, midiLearnTrackStateTargetId } from '@/ui/midi/midi-learn';
import type { AutomationWriteScheduleEvent } from '@/ui/mixer/automation-mode';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, formatPan } from '@/ui/mixer/db-scale';
import { useStripAutomation } from '@/ui/mixer/use-strip-automation';
import { useStripGestures } from '@/ui/mixer/use-strip-gestures';
import InsertRack from './InsertRack.vue';
import MasterMeterReadout from './MasterMeterReadout.vue';
import MixerFader from './MixerFader.vue';
import MixerKnob from './MixerKnob.vue';
import NumericReadout from './NumericReadout.vue';
import SpectrumAnalyzer from './SpectrumAnalyzer.vue';
import StereoGoniometer from './StereoGoniometer.vue';
import StripAutomationControls from './StripAutomationControls.vue';
import StripEqSection from './StripEqSection.vue';
import StripGrMeter from './StripGrMeter.vue';
import StripMeter from './StripMeter.vue';
import StripOptionsPopover from './StripOptionsPopover.vue';
import StripSends from './StripSends.vue';

/**
 * One mixer channel strip (a track or the master): name header with the
 * track color, insert rack, channel EQ, sends, pan knob, mute/solo, and the
 * gain fader next to a stereo meter. All edits go through the undoable
 * command layer; fader and pan drags coalesce into one history entry each.
 *
 * The meter is live whenever a source is supplied (master output or the
 * track's engine lane); without one the strip shows a placeholder.
 *
 * The R/T/L buttons control the strip's session-only automation mode: in
 * 'read' the fader/pan display follows the lane value at the playhead (the
 * control is non-interactive while following), in 'touch'/'latch' drags
 * record breakpoints into the lane instead of driving the manual strip
 * commands. Touch reads the lane back on either side of the touched span;
 * latch holds the last recorded value to the end of the lane.
 *
 * Frozen tracks carry a snowflake tag next to the name (the strip's fader,
 * pan and sends stay live while the track plays its baked render).
 *
 * Group-track strips are tagged GROUP and keep the controls that are meaningful
 * on their group bus: EQ, pan and strip options. Sends, output routing and pan
 * automation remain track-lane features. Fader, mute and inserts keep working
 * through the group-bus sync layer.
 */

const props = withDefaults(
  defineProps<{
    /** Strip target: a track id or 'master'. */
    target: number | 'master';
    /** Live meter source for this strip; null shows a placeholder meter. */
    bridge?: MeterSource | null;
    /** Master analyser tap (master strip only); null draws placeholders. */
    analyser?: AnalyserBridge | null;
    /** Engine scope source (per-target spectrum + goniometer), when available. */
    scope?: ScopeSource | null;
    /** Playhead position getter in PPQ (lane follow / touch recording). */
    positionPpq?: () => number;
    /** Current playhead sample position, used by future sample-accurate scheduling. */
    positionSample?: () => number;
    /** True while the transport runs (continuous touch recording). */
    isPlaying?: boolean;
    /** Whether the mixer dock is visible and realtime displays should run. */
    visible?: boolean;
    /** Optional realtime automation scheduler for write-mode fader/pan drags. */
    scheduleAutomationWrite?: (
      target: number | 'master',
      param: AutomationParam,
      event: AutomationWriteScheduleEvent,
    ) => void;
  }>(),
  {
    bridge: null,
    analyser: null,
    scope: null,
    positionPpq: undefined,
    positionSample: undefined,
    isPlaying: false,
    visible: true,
  },
);

const store = useProjectStore();
const { t } = useI18n();
const appSettings = useAppSettings();
const midiLearn = inject(MIDI_LEARN_KEY, null);

const isMaster = computed(() => props.target === 'master');

const track = computed<EditorTrack | undefined>(() =>
  isMaster.value ? undefined : store.tracks.find((t) => t.id === props.target),
);

const strip = computed<MixerStrip>(() => {
  if (isMaster.value) return store.mixer.master;
  return track.value?.mixer ?? createDefaultStrip();
});

const isGroup = computed(() => track.value?.kind === 'group');

const name = computed(() =>
  isMaster.value ? t.value.shell.mixer.strip.master : (track.value?.name ?? ''),
);
const color = computed(() => (isMaster.value ? '#8b93a3' : (track.value?.color ?? '#5b6270')));
const active = computed(
  () => !isMaster.value && track.value !== undefined && track.value.id === store.activeTrackId,
);

/** Name of the VCA group the track belongs to, or null when unassigned. */
const vcaGroupName = computed<string | null>(() => {
  const id = track.value?.vcaId;
  if (id === undefined) return null;
  return store.mixer.vcaGroups?.find((group) => group.id === id)?.name ?? null;
});

/** True when the track is flagged solo-safe (stays audible during solos). */
const isSoloSafe = computed(() => track.value?.soloSafe === true);

function onSoloClick(track: EditorTrack, event: MouseEvent): void {
  if (event.altKey || event.metaKey || event.ctrlKey) setExclusiveTrackSolo(track.id);
  else setTrackSolo(track.id, !track.solo);
}

/**
 * Output-bus selector is offered on non-group track strips that have at least
 * one send bus to route into. Group members hide it (their group bus always
 * wins); the master strip and group tracks have no routable lane.
 */
const showOutputBus = computed(
  () =>
    !isMaster.value &&
    !isGroup.value &&
    track.value?.groupId === undefined &&
    store.mixer.buses.length > 0,
);

/** Output-bus options: the master mix plus every send bus (value = bus id). */
const outputBusOptions = computed(() => [
  { value: '', label: t.value.shell.mixer.strip.master },
  ...store.mixer.buses.map((bus) => ({ value: bus.id, label: bus.name })),
]);

/** Selected output bus id, or '' for the master mix. */
const outputBusValue = computed(() => strip.value.outputBusId ?? '');

function onOutputBusChange(value: string): void {
  if (!track.value) return;
  setStripOutputBus(track.value.id, value === '' ? null : value);
}

function onHeaderClick(): void {
  if (track.value) setActiveTrack(track.value.id);
}

/** Builds and opens the strip's right-click action menu. */
function onContextMenu(event: MouseEvent): void {
  const currentTrack = track.value;
  if (currentTrack) setActiveTrack(currentTrack.id);
  const items: ContextMenuItem[] = [];
  if (currentTrack) {
    items.push({
      id: 'rename',
      label: t.value.shell.mixer.strip.rename,
      disabled: currentTrack.frozen !== undefined,
      run: async () => {
        const next = await promptDialog({
          title: t.value.shell.mixer.strip.renameTitle,
          message: t.value.shell.mixer.strip.renameMessage,
          defaultValue: currentTrack.name,
          placeholder: t.value.shell.mixer.strip.trackNamePlaceholder,
          confirmLabel: t.value.shell.mixer.strip.renameConfirm,
        });
        if (next && next !== currentTrack.name) renameTrack(currentTrack.id, next);
      },
    });
  }
  items.push({
    id: 'reset-gain',
    label: t.value.shell.mixer.strip.resetFader,
    run: () => setStripGain(props.target, 0),
  });
  items.push({
    id: 'reset-pan',
    label: t.value.shell.mixer.strip.centerPan,
    run: () => setStripPan(props.target, 0),
  });
  if (currentTrack && !isGroup.value) {
    const safe = currentTrack.soloSafe === true;
    items.push(
      { id: 'sep-1', separator: true },
      {
        id: 'mute',
        label: currentTrack.mute
          ? t.value.shell.mixer.strip.unmute
          : t.value.shell.mixer.strip.mute,
        run: () => setTrackMute(currentTrack.id, !currentTrack.mute),
      },
      {
        id: 'solo',
        label: currentTrack.solo
          ? t.value.shell.mixer.strip.unsolo
          : t.value.shell.mixer.strip.solo,
        run: () => setTrackSolo(currentTrack.id, !currentTrack.solo),
      },
      {
        id: 'solo-safe',
        label: t.value.shell.mixer.strip.soloSafe,
        checked: safe,
        run: () => setTrackSoloSafe(currentTrack.id, !safe),
      },
    );
    // VCA assignment: each existing group toggles membership; a new group can
    // be spun up and the track joins it in one step.
    const groups = store.mixer.vcaGroups ?? [];
    items.push({ id: 'sep-vca', separator: true });
    for (const group of groups) {
      const assigned = currentTrack.vcaId === group.id;
      items.push({
        id: `vca-${group.id}`,
        label: group.name,
        checked: assigned,
        run: () => setTrackVca(currentTrack.id, assigned ? null : group.id),
      });
    }
    if (groups.length < MAX_VCA_GROUPS) {
      items.push({
        id: 'vca-new',
        label: t.value.shell.mixer.strip.newVcaGroup,
        run: () => setTrackVca(currentTrack.id, addVcaGroup()),
      });
    }
  }
  openContextMenu(event.clientX, event.clientY, items);
}

// --- Automation follow + fader / pan gestures ---------------------------------

const automation = useStripAutomation({
  target: () => props.target,
  isMaster,
  track,
  strip,
  positionPpq: () => props.positionPpq?.() ?? 0,
  positionSample: props.positionSample,
  isPlaying: () => props.isPlaying,
  scheduleAutomationWrite: props.scheduleAutomationWrite,
});

const { followsFader, followsPan, displayedGainDb, displayedPan } = automation;

const gestures = useStripGestures({
  target: () => props.target,
  strip,
  automation,
});

const { onGainChange, onPanChange: onGesturePanChange } = gestures;

/** Group pan is a direct bus control; its automation lane is intentionally unsupported. */
function onPanChange(pan: number, commit: boolean): void {
  if (isGroup.value) {
    setStripPan(props.target, pan, { commit });
    return;
  }
  onGesturePanChange(pan, commit);
}

/** Group automation state must never override the audible bus pan display. */
const panValue = computed(() => (isGroup.value ? strip.value.pan : displayedPan.value));

function learnTrackStateId(param: MidiLearnTrackStateParam): string {
  return typeof props.target === 'number' ? midiLearnTrackStateTargetId(props.target, param) : '';
}

function learnTrackState(
  param: MidiLearnTrackStateParam,
): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn || typeof props.target !== 'number') return undefined;
  const id = learnTrackStateId(param);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearnTrackState(param: MidiLearnTrackStateParam): void {
  const id = learnTrackStateId(param);
  if (id !== '') midiLearn?.armId(id);
}

function onMidiForgetTrackState(param: MidiLearnTrackStateParam): void {
  const id = learnTrackStateId(param);
  if (id !== '') midiLearn?.clearId(id);
}

onBeforeUnmount(() => {
  // Close any in-flight gesture so the pending history entry is committed and
  // any in-flight touch recording keeps its points.
  gestures.cleanup();
});
</script>

<template>
  <div
    class="channel-strip"
    :class="{ active, master: isMaster }"
    @contextmenu.prevent="onContextMenu"
  >
    <button type="button" class="strip-header" v-tooltip="name" @click="onHeaderClick">
      <span class="strip-color" :style="{ background: color }" />
      <span class="strip-name">{{ name }}</span>
      <span v-if="isGroup" class="strip-group-tag" v-tooltip="t.shell.mixer.strip.groupSubmix">
        {{ t.shell.mixer.strip.group }}
      </span>
      <span v-if="track?.frozen" class="strip-frozen-tag" v-tooltip="t.shell.mixer.strip.frozenTitle">
        <svg viewBox="0 0 16 16" width="8" height="8" fill="none" stroke="currentColor"
          stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5" />
          <path d="M8 4.2 6.5 2.7M8 4.2 9.5 2.7M8 11.8l-1.5 1.5M8 11.8l1.5 1.5" />
        </svg>
      </span>
      <span
        v-if="vcaGroupName"
        class="strip-vca-tag"
        v-tooltip="formatMessage(t.shell.mixer.strip.vcaGroup, { name: vcaGroupName })"
      >
        {{ vcaGroupName }}
      </span>
    </button>

    <StripAutomationControls v-if="!isGroup" :target="props.target" :name="name" />

    <div class="strip-section">
      <InsertRack :target="props.target" />
    </div>

    <div class="strip-section">
      <StripEqSection :target="props.target" :scope="props.scope" />
    </div>

    <div v-if="!isMaster && !isGroup" class="strip-section">
      <StripSends :target="props.target" />
    </div>

    <div v-if="showOutputBus" class="strip-section strip-output">
      <span class="strip-output-label">{{ t.shell.mixer.strip.output }}</span>
      <SelectMenu
        :model-value="outputBusValue"
        size="sm"
        :options="outputBusOptions"
        :aria-label="formatMessage(t.shell.mixer.strip.outputBus, { name })"
        @change="onOutputBusChange"
      />
    </div>

    <div class="strip-spacer" />

    <div class="strip-pan">
      <div class="strip-pan-knob">
        <MixerKnob
          :value="panValue"
          :min="-1"
          :max="1"
          :default-value="0"
          :label="t.shell.mixer.strip.pan"
          :display="formatPan(panValue)"
          :size="24"
          :disabled="isGroup ? false : followsPan"
          @change="onPanChange"
        />
        <NumericReadout
          :value="panValue"
          :min="-1"
          :max="1"
          :step="0.01"
          :display="formatPan(panValue)"
          :ariaLabel="t.shell.mixer.strip.pan"
          :disabled="isGroup ? false : followsPan"
          @change="(value) => onPanChange(value, true)"
        />
        <StripOptionsPopover :target="props.target" :name="name" />
      </div>
      <div v-if="track" class="strip-toggles">
        <button
          type="button"
          class="toggle mute"
          :class="{ on: track.mute }"
          v-tooltip="t.shell.mixer.strip.mute"
          :aria-label="formatMessage(t.shell.mixer.strip.muteNamed, { name })"
          :aria-pressed="track.mute"
          @click="setTrackMute(track.id, !track.mute)"
        >
          M
        </button>
        <button
          v-if="learnTrackState('mute')"
          type="button"
          class="track-state-midi-learn"
          :class="learnTrackState('mute')"
          v-tooltip="
            learnTrackState('mute') === 'armed'
              ? t.shell.mixer.controls.midiLearnListening
              : t.shell.mixer.controls.midiLearn
          "
          :aria-label="t.shell.mixer.controls.midiLearn"
          @click="onMidiLearnTrackState('mute')"
        >
          MIDI
        </button>
        <button
          v-if="learnTrackState('mute') === 'bound'"
          type="button"
          class="track-state-midi-forget"
          v-tooltip="t.shell.mixer.controls.midiForget"
          :aria-label="t.shell.mixer.controls.midiForget"
          @click="onMidiForgetTrackState('mute')"
        >
          ×
        </button>
        <button
          v-if="!isGroup"
          type="button"
          class="toggle solo"
          :class="{ on: track.solo, safe: isSoloSafe }"
          v-tooltip="isSoloSafe ? t.shell.mixer.strip.soloSafeTitle : t.shell.mixer.strip.solo"
          :aria-label="formatMessage(t.shell.mixer.strip.soloNamed, { name })"
          :aria-pressed="track.solo"
          @click="onSoloClick(track, $event)"
        >
          S
        </button>
        <button
          v-if="!isGroup && learnTrackState('solo')"
          type="button"
          class="track-state-midi-learn"
          :class="learnTrackState('solo')"
          v-tooltip="
            learnTrackState('solo') === 'armed'
              ? t.shell.mixer.controls.midiLearnListening
              : t.shell.mixer.controls.midiLearn
          "
          :aria-label="t.shell.mixer.controls.midiLearn"
          @click="onMidiLearnTrackState('solo')"
        >
          MIDI
        </button>
        <button
          v-if="!isGroup && learnTrackState('solo') === 'bound'"
          type="button"
          class="track-state-midi-forget"
          v-tooltip="t.shell.mixer.controls.midiForget"
          :aria-label="t.shell.mixer.controls.midiForget"
          @click="onMidiForgetTrackState('solo')"
        >
          ×
        </button>
      </div>
    </div>

    <div class="strip-fader-row">
      <MixerFader
        :value-db="displayedGainDb"
        :height="132"
        :disabled="followsFader"
        @change="onGainChange"
      />
      <StripMeter
        :bridge="props.bridge"
        :placeholder="!props.bridge"
        :width="12"
        :height="132"
        :visible="props.visible"
      />
    </div>

    <NumericReadout
      class="strip-readout"
      :value="displayedGainDb"
      :min="FADER_MIN_DB"
      :max="FADER_MAX_DB"
      :display="formatDb(displayedGainDb)"
      unit="dB"
      :ariaLabel="t.shell.mixer.controls.stripGain"
      :disabled="followsFader"
      @change="(value) => onGainChange(value, true)"
    />

    <StripGrMeter v-if="!isMaster" :bridge="props.bridge" :visible="props.visible" />

    <MasterMeterReadout
      v-if="isMaster"
      :bridge="props.bridge"
      :target-lufs="appSettings.settings.loudnessTargetLufs"
      :visible="props.visible"
    />

    <div v-if="isMaster || props.scope?.available" class="strip-analyzers">
      <SpectrumAnalyzer
        :analyser="props.analyser"
        :scope="props.scope"
        :height="isMaster ? 48 : 32"
        :visible="props.visible"
      />
      <StereoGoniometer
        :analyser="props.analyser"
        :scope="props.scope"
        :size="isMaster ? 88 : 64"
        :visible="props.visible"
      />
    </div>
  </div>
</template>

<style scoped>
.channel-strip {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: 96px;
  flex: none;
  box-sizing: border-box;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  border-right: 1px solid var(--border);
}

.channel-strip.active {
  background: var(--surface-selected);
}

.channel-strip.master {
  background: var(--surface-2);
  border-left: 1px solid var(--border);
}

.strip-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
  min-width: 0;
}

.strip-color {
  width: 6px;
  height: 14px;
  border-radius: 2px;
  flex: none;
}

.strip-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
}

.strip-group-tag {
  flex: none;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--surface-0);
  background: #a78bfa;
  border-radius: 2px;
  padding: 1px 3px;
}

.strip-frozen-tag {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--surface-0);
  background: #7dd3fc;
  border-radius: 2px;
  padding: 2px;
}

.strip-vca-tag {
  flex: none;
  max-width: 4rem;
  overflow: hidden;
  text-overflow: ellipsis;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--surface-0);
  background: var(--warning);
  border-radius: 2px;
  padding: 1px 3px;
}

.strip-section {
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--sp-2);
}

.strip-output {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.strip-output-label {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
  user-select: none;
}

.strip-output :deep(.select-trigger) {
  flex: 1;
  min-width: 0;
}

.strip-spacer {
  flex: 1;
}

.strip-pan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.strip-pan-knob {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
}

.strip-toggles {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.toggle {
  width: 16px;
  height: 14px;
  font: var(--fw-bold) var(--fs-chrome-lg) var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

.toggle.mute.on {
  color: var(--surface-0);
  background: var(--warning);
}

.toggle.solo.on {
  color: var(--surface-0);
  background: var(--accent);
}

/* Solo-safe is shown as a persistent outline on the S button. */
.toggle.solo.safe {
  box-shadow: inset 0 0 0 1px var(--warning);
}

.track-state-midi-learn,
.track-state-midi-forget {
  flex: none;
  height: 14px;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border: none;
  border-radius: 3px;
  padding: 0 4px;
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.track-state-midi-learn.armed {
  color: var(--surface-0);
  background: var(--accent);
}

.track-state-midi-learn.bound {
  color: var(--accent);
}

.track-state-midi-forget {
  width: 14px;
  padding: 0;
  color: var(--text-4);
}

.strip-fader-row {
  display: flex;
  justify-content: center;
  gap: var(--sp-2);
}

.strip-readout {
  text-align: center;
  font: var(--fs-2xs) var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  user-select: none;
}

.strip-analyzers {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}
</style>

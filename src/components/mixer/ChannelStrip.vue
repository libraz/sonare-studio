<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { promptDialog } from '@/composables/useDialogs';
import type { AnalyserBridge } from '@/engine/analyser';
import type { MeterSource } from '@/engine/meters';
import { linearToDb } from '@/engine/mixer-sync';
import type { ScopeSource } from '@/engine/scope';
import type { AutomationParam } from '@/project/automation';
import { evaluateAutomationValue } from '@/project/automation';
import {
  addVcaGroup,
  renameTrack,
  setActiveTrack,
  setAutomationLanePoints,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripGain,
  setStripInputTrim,
  setStripOutputBus,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setStripPolarityInvert,
  setStripWidth,
  setTrackMute,
  setTrackSolo,
  setTrackSoloSafe,
  setTrackVca,
} from '@/project/commands';
import {
  createDefaultStrip,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_STRIP_WIDTH,
  MAX_VCA_GROUPS,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_WIDTH,
  type MixerStrip,
  PAN_LAW_IDS,
  PAN_MODE_IDS,
  type PanLawId,
  type PanModeId,
} from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import {
  type AutomationWriteGesture,
  type AutomationWriteMode,
  automationStripMode,
  createAutomationWriteGesture,
  isAutomationWriteMode,
  toggleAutomationStripMode,
} from '@/ui/mixer/automation-mode';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, formatPan } from '@/ui/mixer/db-scale';
import { gainGesture, panGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import InsertRack from './InsertRack.vue';
import MasterMeterReadout from './MasterMeterReadout.vue';
import MixerFader from './MixerFader.vue';
import MixerKnob from './MixerKnob.vue';
import SpectrumAnalyzer from './SpectrumAnalyzer.vue';
import StereoGoniometer from './StereoGoniometer.vue';
import StripEqSection from './StripEqSection.vue';
import StripMeter from './StripMeter.vue';
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
 * Group-track strips are tagged GROUP and drop the R/T/L and solo controls:
 * their level is the group bus gain (no automation lane), and bus solo is
 * not supported. Fader, mute, inserts and EQ keep working through the
 * group-bus sync layer.
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
    /** True while the transport runs (continuous touch recording). */
    isPlaying?: boolean;
  }>(),
  { bridge: null, analyser: null, scope: null, positionPpq: undefined, isPlaying: false },
);

const store = useProjectStore();
const { t } = useI18n();
const appSettings = useAppSettings();

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
      run: () => {
        void (async () => {
          const next = await promptDialog({
            title: t.value.shell.mixer.strip.renameTitle,
            message: t.value.shell.mixer.strip.renameMessage,
            defaultValue: currentTrack.name,
            placeholder: t.value.shell.mixer.strip.trackNamePlaceholder,
            confirmLabel: t.value.shell.mixer.strip.renameConfirm,
          });
          if (next && next !== currentTrack.name) renameTrack(currentTrack.id, next);
        })();
      },
    });
  }
  items.push(
    {
      id: 'reset-gain',
      label: t.value.shell.mixer.strip.resetFader,
      run: () => setStripGain(props.target, 0),
    },
    {
      id: 'reset-pan',
      label: t.value.shell.mixer.strip.centerPan,
      run: () => setStripPan(props.target, 0),
    },
  );
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

// --- Automation R/W mode --------------------------------------------------------

const autoMode = computed(() => automationStripMode(props.target));

/** Finds this strip's lane for a parameter (undefined when absent). */
function laneFor(param: AutomationParam) {
  return store.automationLanes.find((lane) => lane.target === props.target && lane.param === param);
}

const faderLane = computed(() => laneFor('faderDb'));
const panLane = computed(() => laneFor('pan'));

/**
 * dB offset between the strip fader domain and the engine lane fader domain
 * (the engine lane fader is linearToDb(track.volume) + strip.gainDb; the
 * master strip has no track volume term).
 */
const laneOffsetDb = computed(() => (isMaster.value ? 0 : linearToDb(track.value?.volume ?? 1)));

/** True when the fader display follows the lane (read mode, usable lane). */
const followsFader = computed(
  () =>
    autoMode.value === 'read' &&
    faderLane.value !== undefined &&
    faderLane.value.enabled &&
    faderLane.value.points.length > 0,
);

/** True when the pan display follows the lane (read mode, usable lane). */
const followsPan = computed(
  () =>
    autoMode.value === 'read' &&
    panLane.value !== undefined &&
    panLane.value.enabled &&
    panLane.value.points.length > 0,
);

/** Live drag value during a write-mode gesture (display only), or null. */
const writeGainDb = ref<number | null>(null);
const writePan = ref<number | null>(null);

/** Fader value shown on the throw: write drag > lane follow > strip state. */
const displayedGainDb = computed(() => {
  if (writeGainDb.value !== null) return writeGainDb.value;
  const lane = faderLane.value;
  if (followsFader.value && lane) {
    const db =
      evaluateAutomationValue(lane.points, props.positionPpq?.() ?? 0) - laneOffsetDb.value;
    return Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db));
  }
  return strip.value.gainDb;
});

/** Pan value shown on the knob: write drag > lane follow > strip state. */
const displayedPan = computed(() => {
  if (writePan.value !== null) return writePan.value;
  const lane = panLane.value;
  if (followsPan.value && lane) {
    return Math.min(
      1,
      Math.max(-1, evaluateAutomationValue(lane.points, props.positionPpq?.() ?? 0)),
    );
  }
  return strip.value.pan;
});

let writeFaderGesture: AutomationWriteGesture | null = null;
let writePanGesture: AutomationWriteGesture | null = null;

/** Starts a touch-record gesture committing into one of this strip's lanes. */
function beginWriteGesture(
  param: AutomationParam,
  mode: AutomationWriteMode,
): AutomationWriteGesture {
  return createAutomationWriteGesture({
    mode,
    existingPoints: laneFor(param)?.points ?? [],
    positionPpq: () => props.positionPpq?.() ?? 0,
    isPlaying: () => props.isPlaying,
    commit: (points) => setAutomationLanePoints(props.target, param, points),
  });
}

// --- Fader / pan gestures -----------------------------------------------------

let activeGainGesture: ValueGesture | null = null;
let activePanGesture: ValueGesture | null = null;

function onGainChange(db: number, commit: boolean): void {
  if (isAutomationWriteMode(autoMode.value)) {
    // Touch recording: the drag writes lane breakpoints (in the engine lane
    // dB domain) instead of the manual strip command, which a lane overrides.
    if (!writeFaderGesture) writeFaderGesture = beginWriteGesture('faderDb', autoMode.value);
    writeFaderGesture.update(laneOffsetDb.value + db);
    writeGainDb.value = db;
    if (commit) {
      writeFaderGesture.end();
      writeFaderGesture = null;
      writeGainDb.value = null;
    }
    return;
  }
  if (!commit) {
    if (!activeGainGesture) activeGainGesture = gainGesture(props.target, strip.value.gainDb);
    activeGainGesture.update(db);
    return;
  }
  if (activeGainGesture) activeGainGesture.end(db);
  else gainGesture(props.target, strip.value.gainDb).end(db);
  activeGainGesture = null;
}

function onPanChange(pan: number, commit: boolean): void {
  if (isAutomationWriteMode(autoMode.value)) {
    if (!writePanGesture) writePanGesture = beginWriteGesture('pan', autoMode.value);
    writePanGesture.update(pan);
    writePan.value = pan;
    if (commit) {
      writePanGesture.end();
      writePanGesture = null;
      writePan.value = null;
    }
    return;
  }
  if (!commit) {
    if (!activePanGesture) activePanGesture = panGesture(props.target, strip.value.pan);
    activePanGesture.update(pan);
    return;
  }
  if (activePanGesture) activePanGesture.end(pan);
  else panGesture(props.target, strip.value.pan).end(pan);
  activePanGesture = null;
}

// --- Strip options popover (trim, width, polarity, pan-law shaping) -----------

/** Strip-local DSP options are available on track and master strips, not groups. */
const canStripOptions = computed(() => !isGroup.value);
/** Panner detail controls are track-lane features (not master/group strips). */
const canTrackPannerOptions = computed(() => typeof props.target === 'number' && !isGroup.value);
const optionsOpen = ref(false);
const optionsMenu = ref<HTMLDivElement | null>(null);

/** Current pre-insert trim in dB (0 when unset). */
const inputTrimDb = computed(() => strip.value.inputTrimDb ?? 0);
/** Current stereo width multiplier (1 when unset). */
const stripWidth = computed(() => strip.value.width ?? DEFAULT_STRIP_WIDTH);
const polarityLeft = computed(() => strip.value.polarityInvertLeft === true);
const polarityRight = computed(() => strip.value.polarityInvertRight === true);
/** Current channel alignment delay in samples (0 when unset). */
const channelDelaySamples = computed(() => strip.value.channelDelaySamples ?? 0);

/** Current pan law (default when unset). */
const panLaw = computed<PanLawId>(() => strip.value.panLaw ?? DEFAULT_PAN_LAW);
/** Current pan mode (default when unset). */
const panMode = computed<PanModeId>(() => strip.value.panMode ?? DEFAULT_PAN_MODE);
/** Left/right pan positions for dual-pan mode (default to the strip pan). */
const dualPanLeft = computed(() => strip.value.dualPan?.left ?? strip.value.pan);
const dualPanRight = computed(() => strip.value.dualPan?.right ?? strip.value.pan);

/** Pan law options for the selector (labels from i18n, value = PanLawId). */
const panLawOptions = computed(() =>
  PAN_LAW_IDS.map((id) => ({ value: id, label: t.value.shell.mixer.strip.panLaws[id] })),
);
/** Pan mode options for the selector (labels from i18n, value = PanModeId). */
const panModeOptions = computed(() =>
  PAN_MODE_IDS.map((id) => ({ value: id, label: t.value.shell.mixer.strip.panModes[id] })),
);

/** True when any strip-panner option deviates from neutral. */
const hasStripOptions = computed(
  () =>
    inputTrimDb.value !== 0 ||
    stripWidth.value !== DEFAULT_STRIP_WIDTH ||
    polarityLeft.value ||
    polarityRight.value ||
    channelDelaySamples.value > 0 ||
    panLaw.value !== DEFAULT_PAN_LAW ||
    panMode.value !== DEFAULT_PAN_MODE ||
    strip.value.dualPan !== undefined,
);

function onInputTrimInput(event: Event, commit: boolean): void {
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw)
    ? Math.min(MAX_INPUT_TRIM_DB, Math.max(MIN_INPUT_TRIM_DB, raw))
    : 0;
  setStripInputTrim(props.target, value, { commit });
}

function onWidthInput(event: Event, commit: boolean): void {
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw)
    ? Math.min(MAX_STRIP_WIDTH, Math.max(MIN_STRIP_WIDTH, raw))
    : DEFAULT_STRIP_WIDTH;
  setStripWidth(props.target, value, { commit });
}

function onPolarityToggle(channel: 'left' | 'right'): void {
  const left = channel === 'left' ? !polarityLeft.value : polarityLeft.value;
  const right = channel === 'right' ? !polarityRight.value : polarityRight.value;
  setStripPolarityInvert(props.target, left, right);
}

function onChannelDelayInput(event: Event): void {
  if (typeof props.target !== 'number') return;
  const raw = Number.parseInt((event.target as HTMLInputElement).value, 10);
  const samples = Number.isFinite(raw) ? Math.min(MAX_CHANNEL_DELAY_SAMPLES, Math.max(0, raw)) : 0;
  setStripChannelDelaySamples(props.target, samples);
}

function onPanLawChange(value: string): void {
  if (typeof props.target !== 'number') return;
  setStripPanLaw(props.target, value as PanLawId);
}

function onPanModeChange(value: string): void {
  if (typeof props.target !== 'number') return;
  setStripPanMode(props.target, value as PanModeId);
}

/** Commits a dual-pan slider edit, keeping the unchanged channel as-is. */
function onDualPanInput(channel: 'left' | 'right', event: Event): void {
  if (typeof props.target !== 'number') return;
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw) ? Math.min(1, Math.max(-1, raw)) : 0;
  const left = channel === 'left' ? value : dualPanLeft.value;
  const right = channel === 'right' ? value : dualPanRight.value;
  setStripDualPan(props.target, left, right);
}

function onOptionsPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !optionsMenu.value?.contains(event.target)) {
    optionsOpen.value = false;
  }
}

watch(optionsOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onOptionsPointerDown, true);
  else document.removeEventListener('pointerdown', onOptionsPointerDown, true);
});

onBeforeUnmount(() => {
  // Close any in-flight gesture so the pending history entry is committed.
  activeGainGesture?.cancel();
  activePanGesture?.cancel();
  // Commit any in-flight touch recording so its points are not lost.
  writeFaderGesture?.end();
  writePanGesture?.end();
  document.removeEventListener('pointerdown', onOptionsPointerDown, true);
});
</script>

<template>
  <div
    class="channel-strip"
    :class="{ active, master: isMaster }"
    @contextmenu.prevent="onContextMenu"
  >
    <button type="button" class="strip-header" :title="name" @click="onHeaderClick">
      <span class="strip-color" :style="{ background: color }" />
      <span class="strip-name">{{ name }}</span>
      <span v-if="isGroup" class="strip-group-tag" :title="t.shell.mixer.strip.groupSubmix">
        {{ t.shell.mixer.strip.group }}
      </span>
      <span v-if="track?.frozen" class="strip-frozen-tag" :title="t.shell.mixer.strip.frozenTitle">
        ❄
      </span>
      <span
        v-if="vcaGroupName"
        class="strip-vca-tag"
        :title="formatMessage(t.shell.mixer.strip.vcaGroup, { name: vcaGroupName })"
      >
        {{ vcaGroupName }}
      </span>
    </button>

    <div v-if="!isGroup" class="strip-auto">
      <button
        type="button"
        class="toggle strip-auto-r"
        :class="{ on: autoMode === 'read' }"
        :title="t.shell.mixer.strip.automationReadTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationRead, { name })"
        :aria-pressed="autoMode === 'read'"
        @click="toggleAutomationStripMode(props.target, 'read')"
      >
        R
      </button>
      <button
        type="button"
        class="toggle strip-auto-t"
        :class="{ on: autoMode === 'touch' }"
        :title="t.shell.mixer.strip.automationTouchTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationTouch, { name })"
        :aria-pressed="autoMode === 'touch'"
        @click="toggleAutomationStripMode(props.target, 'touch')"
      >
        T
      </button>
      <button
        type="button"
        class="toggle strip-auto-l"
        :class="{ on: autoMode === 'latch' }"
        :title="t.shell.mixer.strip.automationLatchTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationLatch, { name })"
        :aria-pressed="autoMode === 'latch'"
        @click="toggleAutomationStripMode(props.target, 'latch')"
      >
        L
      </button>
    </div>

    <div class="strip-section">
      <InsertRack :target="props.target" />
    </div>

    <div class="strip-section">
      <StripEqSection :target="props.target" />
    </div>

    <div class="strip-section">
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
          :value="displayedPan"
          :min="-1"
          :max="1"
          :default-value="0"
          :label="t.shell.mixer.strip.pan"
          :display="formatPan(displayedPan)"
          :size="24"
          :disabled="followsPan"
          @change="onPanChange"
        />
        <div v-if="canStripOptions" ref="optionsMenu" class="strip-options">
          <button
            type="button"
            class="strip-options-btn"
            :class="{ on: hasStripOptions }"
            :title="t.shell.mixer.strip.options"
            :aria-label="formatMessage(t.shell.mixer.strip.optionsNamed, { name })"
            aria-haspopup="menu"
            :aria-expanded="optionsOpen"
            @click="optionsOpen = !optionsOpen"
          >
            ⚙
          </button>
          <div v-if="optionsOpen" class="strip-options-popover" role="menu">
            <label class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.inputTrim }}</span>
              <span class="strip-options-field">
                <input
                  type="range"
                  :min="MIN_INPUT_TRIM_DB"
                  :max="MAX_INPUT_TRIM_DB"
                  step="0.5"
                  :value="inputTrimDb"
                  :aria-label="t.shell.mixer.strip.inputTrim"
                  @input="onInputTrimInput($event, false)"
                  @change="onInputTrimInput($event, true)"
                />
                <span class="strip-options-unit">{{ formatDb(inputTrimDb) }}</span>
              </span>
            </label>
            <label class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.width }}</span>
              <span class="strip-options-field">
                <input
                  type="range"
                  :min="MIN_STRIP_WIDTH"
                  :max="MAX_STRIP_WIDTH"
                  step="0.01"
                  :value="stripWidth"
                  :aria-label="t.shell.mixer.strip.width"
                  @input="onWidthInput($event, false)"
                  @change="onWidthInput($event, true)"
                />
                <span class="strip-options-unit">{{ stripWidth.toFixed(2) }}</span>
              </span>
            </label>
            <div class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.polarity }}</span>
              <span class="strip-options-field strip-options-toggles">
                <button
                  type="button"
                  class="toggle"
                  :class="{ on: polarityLeft }"
                  :aria-pressed="polarityLeft"
                  :aria-label="t.shell.mixer.strip.polarityLeft"
                  @click="onPolarityToggle('left')"
                >
                  L
                </button>
                <button
                  type="button"
                  class="toggle"
                  :class="{ on: polarityRight }"
                  :aria-pressed="polarityRight"
                  :aria-label="t.shell.mixer.strip.polarityRight"
                  @click="onPolarityToggle('right')"
                >
                  R
                </button>
              </span>
            </div>
            <label v-if="canTrackPannerOptions" class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.channelDelay }}</span>
              <span class="strip-options-field">
                <input
                  type="number"
                  min="0"
                  :max="MAX_CHANNEL_DELAY_SAMPLES"
                  step="1"
                  :value="channelDelaySamples"
                  :aria-label="t.shell.mixer.strip.channelDelay"
                  @change="onChannelDelayInput"
                />
                <span class="strip-options-unit">{{ t.shell.mixer.strip.samples }}</span>
              </span>
            </label>
            <div v-if="canTrackPannerOptions" class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.panLaw }}</span>
              <span class="strip-options-field">
                <SelectMenu
                  :model-value="panLaw"
                  size="sm"
                  :options="panLawOptions"
                  :aria-label="t.shell.mixer.strip.panLaw"
                  @change="onPanLawChange"
                />
              </span>
            </div>
            <div v-if="canTrackPannerOptions" class="strip-options-row">
              <span class="strip-options-label">{{ t.shell.mixer.strip.panMode }}</span>
              <span class="strip-options-field">
                <SelectMenu
                  :model-value="panMode"
                  size="sm"
                  :options="panModeOptions"
                  :aria-label="t.shell.mixer.strip.panMode"
                  @change="onPanModeChange"
                />
              </span>
            </div>
            <template v-if="canTrackPannerOptions && panMode === 'dualPan'">
              <label class="strip-options-row">
                <span class="strip-options-label">{{ t.shell.mixer.strip.dualPanLeft }}</span>
                <span class="strip-options-field">
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    :value="dualPanLeft"
                    :aria-label="t.shell.mixer.strip.dualPanLeft"
                    @input="onDualPanInput('left', $event)"
                  />
                  <span class="strip-options-unit">{{ formatPan(dualPanLeft) }}</span>
                </span>
              </label>
              <label class="strip-options-row">
                <span class="strip-options-label">{{ t.shell.mixer.strip.dualPanRight }}</span>
                <span class="strip-options-field">
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    :value="dualPanRight"
                    :aria-label="t.shell.mixer.strip.dualPanRight"
                    @input="onDualPanInput('right', $event)"
                  />
                  <span class="strip-options-unit">{{ formatPan(dualPanRight) }}</span>
                </span>
              </label>
            </template>
          </div>
        </div>
      </div>
      <div v-if="track" class="strip-toggles">
        <button
          type="button"
          class="toggle mute"
          :class="{ on: track.mute }"
          :title="t.shell.mixer.strip.mute"
          :aria-label="formatMessage(t.shell.mixer.strip.muteNamed, { name })"
          :aria-pressed="track.mute"
          @click="setTrackMute(track.id, !track.mute)"
        >
          M
        </button>
        <button
          v-if="!isGroup"
          type="button"
          class="toggle solo"
          :class="{ on: track.solo, safe: isSoloSafe }"
          :title="isSoloSafe ? t.shell.mixer.strip.soloSafeTitle : t.shell.mixer.strip.solo"
          :aria-label="formatMessage(t.shell.mixer.strip.soloNamed, { name })"
          :aria-pressed="track.solo"
          @click="setTrackSolo(track.id, !track.solo)"
        >
          S
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
      />
    </div>

    <div class="strip-readout">{{ formatDb(displayedGainDb) }} dB</div>

    <MasterMeterReadout
      v-if="isMaster"
      :bridge="props.bridge"
      :target-lufs="appSettings.settings.loudnessTargetLufs"
    />

    <div v-if="isMaster || props.scope?.available" class="strip-analyzers">
      <SpectrumAnalyzer :analyser="props.analyser" :scope="props.scope" :height="isMaster ? 48 : 32" />
      <StereoGoniometer :analyser="props.analyser" :scope="props.scope" :size="isMaster ? 88 : 64" />
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
  font: 600 10px system-ui, sans-serif;
  color: var(--text-2);
}

.strip-group-tag {
  flex: none;
  font: 700 7px system-ui, sans-serif;
  letter-spacing: 0.06em;
  color: var(--surface-0);
  background: #a78bfa;
  border-radius: 2px;
  padding: 1px 3px;
}

.strip-frozen-tag {
  flex: none;
  font: 700 8px system-ui, sans-serif;
  color: var(--surface-0);
  background: #7dd3fc;
  border-radius: 2px;
  padding: 1px 3px;
}

.strip-vca-tag {
  flex: none;
  max-width: 4rem;
  overflow: hidden;
  text-overflow: ellipsis;
  font: 700 7px system-ui, sans-serif;
  letter-spacing: 0.04em;
  color: var(--surface-0);
  background: #fbbf24;
  border-radius: 2px;
  padding: 1px 3px;
}

.strip-auto {
  display: flex;
  gap: var(--sp-1);
}

.strip-auto-r.on {
  color: var(--surface-0);
  background: var(--success);
}

.strip-auto-t.on {
  color: var(--surface-0);
  background: #fbbf24;
}

.strip-auto-l.on {
  color: var(--surface-0);
  background: #f87171;
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
  font: var(--fw-bold) 8px var(--font-sans);
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

.strip-options {
  position: relative;
}

.strip-options-btn {
  width: 14px;
  height: 14px;
  font: 9px system-ui, sans-serif;
  line-height: 1;
  color: var(--text-4);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
}

.strip-options-btn.on {
  color: var(--accent);
}

.strip-options-popover {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 20;
  min-width: 132px;
  padding: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-raised);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
}

.strip-options-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.strip-options-label {
  font: var(--fw-semibold) 8px var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.strip-options-field {
  display: flex;
  align-items: center;
  gap: 4px;
}

.strip-options-toggles {
  gap: var(--sp-1);
}

.strip-options-field input {
  width: 64px;
  font: 10px var(--font-sans);
  color: var(--text-2);
  background: var(--inset-well);
  border: 1px solid var(--border);
  border-radius: var(--radius-1);
  padding: 1px 4px;
}

.strip-options-unit {
  font: 8px var(--font-sans);
  color: var(--text-4);
}

.strip-toggles {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.toggle {
  width: 16px;
  height: 14px;
  font: 700 9px system-ui, sans-serif;
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
  box-shadow: inset 0 0 0 1px #fbbf24;
}

.strip-fader-row {
  display: flex;
  justify-content: center;
  gap: var(--sp-2);
}

.strip-readout {
  text-align: center;
  font: 10px ui-monospace, monospace;
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

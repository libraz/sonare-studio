<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { promptDialog } from '@/composables/useDialogs';
import type { MeterSource } from '@/engine/meters';
import { linearToDb } from '@/engine/mixer-sync';
import type { AutomationParam } from '@/project/automation';
import { evaluateAutomationValue } from '@/project/automation';
import type { MixerStripTarget } from '@/project/commands';
import {
  addVcaGroup,
  renameTrack,
  setActiveTrack,
  setAutomationLanePoints,
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
import {
  type AutomationWriteGesture,
  automationStripMode,
  createAutomationWriteGesture,
  toggleAutomationStripMode,
} from '@/ui/mixer/automation-mode';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, formatPan } from '@/ui/mixer/db-scale';
import { gainGesture, panGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import InsertRack from './InsertRack.vue';
import MixerFader from './MixerFader.vue';
import MixerKnob from './MixerKnob.vue';
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
 * The R/W buttons control the strip's session-only automation mode: in
 * 'read' the fader/pan display follows the lane value at the playhead (the
 * control is non-interactive while following), in 'write' drags touch-record
 * breakpoints into the lane instead of driving the manual strip commands.
 *
 * Frozen tracks carry a snowflake tag next to the name (the strip's fader,
 * pan and sends stay live while the track plays its baked render).
 *
 * Group-track strips are tagged GROUP and drop the R/W and solo controls:
 * their level is the group bus gain (no automation lane), and bus solo is
 * not supported. Fader, mute, inserts and EQ keep working through the
 * group-bus sync layer.
 */

const props = withDefaults(
  defineProps<{
    /** Strip target: a track id or 'master'. */
    target: MixerStripTarget;
    /** Live meter source for this strip; null shows a placeholder meter. */
    bridge?: MeterSource | null;
    /** Playhead position getter in PPQ (lane follow / touch recording). */
    positionPpq?: () => number;
    /** True while the transport runs (continuous touch recording). */
    isPlaying?: boolean;
  }>(),
  { bridge: null, positionPpq: undefined, isPlaying: false },
);

const store = useProjectStore();
const { t } = useI18n();

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
function beginWriteGesture(param: AutomationParam): AutomationWriteGesture {
  return createAutomationWriteGesture({
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
  if (autoMode.value === 'write') {
    // Touch recording: the drag writes lane breakpoints (in the engine lane
    // dB domain) instead of the manual strip command, which a lane overrides.
    if (!writeFaderGesture) writeFaderGesture = beginWriteGesture('faderDb');
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
  if (autoMode.value === 'write') {
    if (!writePanGesture) writePanGesture = beginWriteGesture('pan');
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

onBeforeUnmount(() => {
  // Close any in-flight gesture so the pending history entry is committed.
  activeGainGesture?.cancel();
  activePanGesture?.cancel();
  // Commit any in-flight touch recording so its points are not lost.
  writeFaderGesture?.end();
  writePanGesture?.end();
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
        class="toggle strip-auto-w"
        :class="{ on: autoMode === 'write' }"
        :title="t.shell.mixer.strip.automationWriteTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationWrite, { name })"
        :aria-pressed="autoMode === 'write'"
        @click="toggleAutomationStripMode(props.target, 'write')"
      >
        W
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

.strip-auto-w.on {
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
</style>

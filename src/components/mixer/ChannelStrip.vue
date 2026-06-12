<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import type { MeterSource } from '@/engine/meters';
import type { MixerStripTarget } from '@/project/commands';
import { setActiveTrack, setTrackMute, setTrackSolo } from '@/project/commands';
import { createDefaultStrip, type MixerStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatDb, formatPan } from '@/ui/mixer/db-scale';
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
 */

const props = withDefaults(
  defineProps<{
    /** Strip target: a track id or 'master'. */
    target: MixerStripTarget;
    /** Live meter source for this strip; null shows a placeholder meter. */
    bridge?: MeterSource | null;
  }>(),
  { bridge: null },
);

const store = useProjectStore();

const isMaster = computed(() => props.target === 'master');

const track = computed<EditorTrack | undefined>(() =>
  isMaster.value ? undefined : store.tracks.find((t) => t.id === props.target),
);

const strip = computed<MixerStrip>(() => {
  if (isMaster.value) return store.mixer.master;
  return track.value?.mixer ?? createDefaultStrip();
});

const name = computed(() => (isMaster.value ? 'Master' : (track.value?.name ?? '')));
const color = computed(() => (isMaster.value ? '#8b93a3' : (track.value?.color ?? '#5b6270')));
const active = computed(
  () => !isMaster.value && track.value !== undefined && track.value.id === store.activeTrackId,
);

function onHeaderClick(): void {
  if (track.value) setActiveTrack(track.value.id);
}

// --- Fader / pan gestures -----------------------------------------------------

let activeGainGesture: ValueGesture | null = null;
let activePanGesture: ValueGesture | null = null;

function onGainChange(db: number, commit: boolean): void {
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
});
</script>

<template>
  <div class="channel-strip" :class="{ active, master: isMaster }">
    <button type="button" class="strip-header" :title="name" @click="onHeaderClick">
      <span class="strip-color" :style="{ background: color }" />
      <span class="strip-name">{{ name }}</span>
    </button>

    <div class="strip-section">
      <InsertRack :target="props.target" />
    </div>

    <div class="strip-section">
      <StripEqSection :target="props.target" />
    </div>

    <div class="strip-section">
      <StripSends :target="props.target" />
    </div>

    <div class="strip-spacer" />

    <div class="strip-pan">
      <MixerKnob
        :value="strip.pan"
        :min="-1"
        :max="1"
        :default-value="0"
        label="Pan"
        :display="formatPan(strip.pan)"
        :size="24"
        @change="onPanChange"
      />
      <div v-if="track" class="strip-toggles">
        <button
          type="button"
          class="toggle mute"
          :class="{ on: track.mute }"
          title="Mute"
          :aria-label="`Mute ${name}`"
          :aria-pressed="track.mute"
          @click="setTrackMute(track.id, !track.mute)"
        >
          M
        </button>
        <button
          type="button"
          class="toggle solo"
          :class="{ on: track.solo }"
          title="Solo"
          :aria-label="`Solo ${name}`"
          :aria-pressed="track.solo"
          @click="setTrackSolo(track.id, !track.solo)"
        >
          S
        </button>
      </div>
    </div>

    <div class="strip-fader-row">
      <MixerFader :value-db="strip.gainDb" :height="132" @change="onGainChange" />
      <StripMeter
        :bridge="props.bridge"
        :placeholder="!props.bridge"
        :width="12"
        :height="132"
      />
    </div>

    <div class="strip-readout">{{ formatDb(strip.gainDb) }} dB</div>
  </div>
</template>

<style scoped>
.channel-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 96px;
  flex: none;
  box-sizing: border-box;
  padding: 6px 6px 8px;
  background: #15171c;
  border-right: 1px solid rgba(0, 0, 0, 0.5);
}

.channel-strip.active {
  background: #1b2330;
}

.channel-strip.master {
  background: #181b22;
  border-left: 1px solid #2a2e37;
}

.strip-header {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
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
  color: #c8cdd6;
}

.strip-section {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 4px;
}

.strip-spacer {
  flex: 1;
}

.strip-pan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.strip-toggles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle {
  width: 16px;
  height: 14px;
  font: 700 9px system-ui, sans-serif;
  line-height: 1;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
}

.toggle.mute.on {
  color: #0b0d11;
  background: #fbbf24;
  border-color: #fbbf24;
}

.toggle.solo.on {
  color: #0b0d11;
  background: #60a5fa;
  border-color: #60a5fa;
}

.strip-fader-row {
  display: flex;
  justify-content: center;
  gap: 4px;
}

.strip-readout {
  text-align: center;
  font: 10px ui-monospace, monospace;
  color: #8b93a3;
  user-select: none;
}
</style>

<script setup lang="ts">
import LevelMeter from '@/components/LevelMeter.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import type { useRecording } from '@/composables/useRecording';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';

type Recording = ReturnType<typeof useRecording>;

defineProps<{
  autoPunchEnabled: boolean;
  bbtDisplay: string;
  bridge: MeterBridge | null;
  countInChoices: readonly { value: number; label: string }[];
  handle: EngineHandle | null;
  hasLocatorWindow: boolean;
  isPlaying: boolean;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  positionSeconds: number;
  recording: Recording;
  recordMenuOpen: boolean;
  shortcutTitle: (base: string, actionId: string) => string;
  storeInitialized: boolean;
  tempoInput: number;
}>();

const emit = defineEmits<{
  applyTempo: [];
  bbtBlur: [];
  bbtFocus: [];
  countInChange: [bars: number];
  nudgeByBar: [direction: -1 | 1];
  recordMenuRef: [el: HTMLElement | null];
  seekToEnd: [];
  seekToStart: [];
  setLeftLocator: [];
  setRightLocator: [];
  startPlayback: [];
  stopPlayback: [];
  toggleAutoPunch: [];
  toggleLoop: [];
  toggleMetronome: [];
  toggleRecord: [];
  updateBbtDraft: [value: string];
  updateRecordMenuOpen: [open: boolean];
  updateTempoInput: [value: number];
}>();
</script>

<template>
  <footer class="transport-bar" aria-label="Transport">
    <div class="transport-cluster" role="group" aria-label="Transport">
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        aria-label="Go to start"
        title="Go to start (Home)"
        @click="emit('seekToStart')"
      >
        <TransportIcon name="to-start" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        aria-label="Nudge back one bar"
        title="Nudge back one bar (,)"
        @click="emit('nudgeByBar', -1)"
      >
        <TransportIcon name="rewind" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        aria-label="Nudge forward one bar"
        title="Nudge forward one bar (.)"
        @click="emit('nudgeByBar', 1)"
      >
        <TransportIcon name="forward" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        aria-label="Go to end"
        title="Go to end (End)"
        @click="emit('seekToEnd')"
      >
        <TransportIcon name="to-end" />
      </button>
      <span class="cluster-divider" aria-hidden="true" />
      <button
        type="button"
        class="transport-key cycle"
        :class="{ active: loopEnabled }"
        :disabled="!handle"
        aria-label="Cycle"
        :aria-pressed="loopEnabled"
        :title="shortcutTitle('Cycle (loop between the L and R locators)', 'transport.toggleLoop')"
        @click="emit('toggleLoop')"
      >
        <TransportIcon name="cycle" />
      </button>
      <button
        type="button"
        class="transport-key stop"
        :disabled="!handle || !isPlaying"
        aria-label="Stop"
        title="Stop (Space)"
        @click="emit('stopPlayback')"
      >
        <TransportIcon name="stop" />
      </button>
      <button
        type="button"
        class="transport-key play"
        :class="{ active: isPlaying }"
        :disabled="!storeInitialized"
        aria-label="Play"
        :aria-pressed="isPlaying"
        title="Play (Space) - boots the audio engine on first press"
        @click="emit('startPlayback')"
      >
        <TransportIcon name="play" />
      </button>
      <div
        :ref="(el) => emit('recordMenuRef', el as HTMLElement | null)"
        class="record-group"
        @keydown.escape="emit('updateRecordMenuOpen', false)"
      >
        <button
          type="button"
          class="transport-key record-button"
          :class="{
            recording: recording.isRecording.value,
            'counting-in': recording.isCountingIn.value,
          }"
          aria-label="Record"
          :aria-pressed="recording.isRecording.value"
          :disabled="!handle || (!recording.isRecording.value && recording.armedTrackId.value === null)"
          :title="
            recording.isRecording.value
              ? 'Stop recording (the take lands as a clip)'
              : 'Record onto the armed audio track'
          "
          @click="emit('toggleRecord')"
        >
          <TransportIcon name="record" />
        </button>
        <button
          type="button"
          class="record-settings"
          aria-label="Recording settings"
          aria-haspopup="true"
          :aria-expanded="recordMenuOpen"
          title="Recording settings"
          @click="emit('updateRecordMenuOpen', !recordMenuOpen)"
        >
          <TransportIcon name="chevron-down" />
        </button>
        <div
          v-if="recordMenuOpen"
          class="menu-pop record-pop record-pop-up"
          role="group"
          aria-label="Recording settings"
        >
          <label class="bar-field">
            <input
              type="checkbox"
              :checked="recording.monitorEnabled.value"
              @change="recording.setMonitor(!recording.monitorEnabled.value)"
            />
            Monitor input
          </label>
          <label class="bar-field">
            Count-in
            <SelectMenu
              :model-value="recording.countInBars.value"
              :options="countInChoices"
              size="sm"
              aria-label="Count-in"
              @change="emit('countInChange', $event)"
            />
          </label>
          <label
            class="bar-field"
            :title="
              hasLocatorWindow
                ? 'Record only between the L and R locators (auto in/out)'
                : 'Set the L and R locators first (auto in/out needs a window)'
            "
          >
            <input
              type="checkbox"
              :checked="autoPunchEnabled"
              :disabled="!hasLocatorWindow"
              @change="emit('toggleAutoPunch')"
            />
            Auto-punch (locators)
          </label>
        </div>
        <span
          v-if="recording.armedTrackId.value !== null"
          class="input-level"
          title="Microphone input level"
        >
          <span
            class="input-level-fill"
            :style="{ width: `${Math.min(1, recording.inputLevel.value) * 100}%` }"
          />
        </span>
      </div>
    </div>

    <div class="transport-module" role="group" aria-label="Tempo and metronome">
      <span class="module-cap">Tempo</span>
      <label class="tempo-field" aria-label="Tempo in beats per minute">
        <input
          :value="tempoInput"
          type="number"
          min="20"
          max="300"
          step="1"
          class="tempo-input"
          :disabled="!storeInitialized"
          @input="emit('updateTempoInput', Number(($event.target as HTMLInputElement).value))"
          @change="emit('applyTempo')"
        />
        <span class="tempo-unit" aria-hidden="true">BPM</span>
      </label>
      <button
        type="button"
        class="click-toggle"
        :class="{ active: metronomeEnabled }"
        :disabled="!handle"
        aria-label="Metronome click"
        :aria-pressed="metronomeEnabled"
        title="Metronome click"
        @click="emit('toggleMetronome')"
      >
        <TransportIcon name="metronome" />
      </button>
    </div>

    <div class="transport-module" role="group" aria-label="Loop locators">
      <span class="module-cap">Loc</span>
      <div class="locator-group">
        <button
          type="button"
          class="transport-nav locator"
          :disabled="!handle"
          aria-label="Set left locator to playhead"
          :title="shortcutTitle('Set left locator to the playhead', 'transport.setLeftLocator')"
          @click="emit('setLeftLocator')"
        >
          L
        </button>
        <button
          type="button"
          class="transport-nav locator"
          :disabled="!handle"
          aria-label="Set right locator to playhead"
          :title="shortcutTitle('Set right locator to the playhead', 'transport.setRightLocator')"
          @click="emit('setRightLocator')"
        >
          R
        </button>
      </div>
      <button
        v-if="autoPunchEnabled"
        type="button"
        class="punch-indicator"
        aria-label="Auto-punch armed"
        title="Auto-punch armed - recording opens at L and stops at R. Click to disarm."
        @click="emit('toggleAutoPunch')"
      >
        PUNCH
      </button>
    </div>

    <span class="bar-spacer" />

    <div class="time-display" :class="{ playing: isPlaying }">
      <div class="time-register time-primary">
        <span class="time-cap">Bars</span>
        <input
          class="position-bbt"
          type="text"
          inputmode="numeric"
          spellcheck="false"
          :value="bbtDisplay"
          aria-label="Playhead position in bars, beats, sixteenths and ticks"
          title="Bar.Beat.Sixteenth.Tick - type a position and press Enter to move the playhead"
          @focus="emit('bbtFocus')"
          @input="emit('updateBbtDraft', ($event.target as HTMLInputElement).value)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="emit('bbtBlur')"
        />
      </div>
      <div class="time-register time-secondary">
        <span class="time-cap">Time</span>
        <span class="position-seconds">{{ positionSeconds.toFixed(2) }}s</span>
      </div>
    </div>

    <LevelMeter :bridge="bridge" :width="120" :height="36" />
  </footer>
</template>

<style scoped src="@/ui/shell/transport-bar.css"></style>

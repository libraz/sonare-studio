<script setup lang="ts">
import { computed } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import type { useRecording } from '@/composables/useRecording';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import { formatMessage, useI18n } from '@/ui/i18n';

type Recording = ReturnType<typeof useRecording>;

const props = defineProps<{
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

const { t } = useI18n();

const countInOptions = computed(() =>
  props.countInChoices.map((choice) => ({
    value: choice.value,
    label:
      choice.value === 0
        ? t.value.shell.transport.countInOff
        : choice.value === 1
          ? t.value.shell.transport.countInOne
          : formatMessage(t.value.shell.transport.countInMany, { count: String(choice.value) }),
  })),
);
</script>

<template>
  <footer class="transport-bar" :aria-label="t.shell.transport.label">
    <div class="transport-cluster" role="group" :aria-label="t.shell.transport.label">
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        :aria-label="t.shell.transport.goToStart"
        v-tooltip="t.shell.transport.goToStartTitle"
        @click="emit('seekToStart')"
      >
        <TransportIcon name="to-start" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        :aria-label="t.shell.transport.nudgeBack"
        v-tooltip="t.shell.transport.nudgeBackTitle"
        @click="emit('nudgeByBar', -1)"
      >
        <TransportIcon name="rewind" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        :aria-label="t.shell.transport.nudgeForward"
        v-tooltip="t.shell.transport.nudgeForwardTitle"
        @click="emit('nudgeByBar', 1)"
      >
        <TransportIcon name="forward" />
      </button>
      <button
        type="button"
        class="transport-nav"
        :disabled="!handle"
        :aria-label="t.shell.transport.goToEnd"
        v-tooltip="t.shell.transport.goToEndTitle"
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
        :aria-label="t.shell.transport.cycle"
        :aria-pressed="loopEnabled"
        v-tooltip="shortcutTitle(t.shell.transport.cycleTitle, 'transport.toggleLoop')"
        @click="emit('toggleLoop')"
      >
        <TransportIcon name="cycle" />
      </button>
      <button
        type="button"
        class="transport-key stop"
        :disabled="!handle || !isPlaying"
        :aria-label="t.shell.transport.stop"
        v-tooltip="t.shell.transport.stopTitle"
        @click="emit('stopPlayback')"
      >
        <TransportIcon name="stop" />
      </button>
      <button
        type="button"
        class="transport-key play"
        :class="{ active: isPlaying }"
        :disabled="!storeInitialized"
        :aria-label="t.shell.transport.play"
        :aria-pressed="isPlaying"
        v-tooltip="t.shell.transport.playTitle"
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
          :aria-label="t.shell.transport.record"
          :aria-pressed="recording.isRecording.value"
          :disabled="!handle || (!recording.isRecording.value && recording.armedTrackId.value === null)"
          v-tooltip="
            recording.isRecording.value
              ? t.shell.transport.recordStopTitle
              : t.shell.transport.recordStartTitle
          "
          @click="emit('toggleRecord')"
        >
          <TransportIcon name="record" />
        </button>
        <button
          type="button"
          class="record-settings"
          :aria-label="t.shell.transport.recordingSettings"
          aria-haspopup="true"
          :aria-expanded="recordMenuOpen"
          v-tooltip="t.shell.transport.recordingSettings"
          @click="emit('updateRecordMenuOpen', !recordMenuOpen)"
        >
          <TransportIcon name="chevron-down" />
        </button>
        <div
          v-if="recordMenuOpen"
          class="menu-pop record-pop record-pop-up"
          role="group"
          :aria-label="t.shell.transport.recordingSettings"
        >
          <ToggleButton
            :model-value="recording.monitorEnabled.value"
            :label="t.shell.transport.monitorInput"
            size="sm"
            @update:model-value="recording.setMonitor($event)"
          />
          <label class="bar-field">
            {{ t.shell.transport.countIn }}
            <SelectMenu
              :model-value="recording.countInBars.value"
              :options="countInOptions"
              size="sm"
              :aria-label="t.shell.transport.countIn"
              @change="emit('countInChange', $event)"
            />
          </label>
          <ToggleButton
            :model-value="autoPunchEnabled"
            :label="t.shell.transport.autoPunch"
            size="sm"
            :disabled="!hasLocatorWindow"
            :title="
              hasLocatorWindow
                ? t.shell.transport.autoPunchReadyTitle
                : t.shell.transport.autoPunchNeedsWindowTitle
            "
            @update:model-value="emit('toggleAutoPunch')"
          />
        </div>
        <span
          v-if="recording.armedTrackId.value !== null"
          class="input-level"
          v-tooltip="t.shell.transport.inputLevel"
        >
          <span
            class="input-level-fill"
            :style="{ width: `${Math.min(1, recording.inputLevel.value) * 100}%` }"
          />
        </span>
      </div>
    </div>

    <div class="transport-module" role="group" :aria-label="t.shell.transport.tempoGroup">
      <span class="module-cap">{{ t.shell.transport.tempo }}</span>
      <label class="tempo-field" :aria-label="t.shell.transport.tempoLabel">
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
        :aria-label="t.shell.transport.metronome"
        :aria-pressed="metronomeEnabled"
        v-tooltip="t.shell.transport.metronome"
        @click="emit('toggleMetronome')"
      >
        <TransportIcon name="metronome" />
      </button>
    </div>

    <div class="transport-module" role="group" :aria-label="t.shell.transport.locatorsGroup">
      <span class="module-cap">{{ t.shell.transport.locators }}</span>
      <div class="locator-group">
        <button
          type="button"
          class="transport-nav locator"
          :disabled="!handle"
          :aria-label="t.shell.transport.setLeftLocator"
          v-tooltip="shortcutTitle(t.shell.transport.setLeftLocatorTitle, 'transport.setLeftLocator')"
          @click="emit('setLeftLocator')"
        >
          L
        </button>
        <button
          type="button"
          class="transport-nav locator"
          :disabled="!handle"
          :aria-label="t.shell.transport.setRightLocator"
          v-tooltip="
            shortcutTitle(t.shell.transport.setRightLocatorTitle, 'transport.setRightLocator')
          "
          @click="emit('setRightLocator')"
        >
          R
        </button>
      </div>
      <button
        v-if="autoPunchEnabled"
        type="button"
        class="punch-indicator"
        :aria-label="t.shell.transport.autoPunchArmed"
        v-tooltip="t.shell.transport.autoPunchArmedTitle"
        @click="emit('toggleAutoPunch')"
      >
        {{ t.shell.transport.punch }}
      </button>
    </div>

    <span class="bar-spacer" />

    <div class="time-display" :class="{ playing: isPlaying }">
      <div class="time-register time-primary">
        <span class="time-cap">{{ t.shell.transport.bars }}</span>
        <input
          class="position-bbt"
          type="text"
          inputmode="numeric"
          spellcheck="false"
          :value="bbtDisplay"
          :aria-label="t.shell.transport.playheadPosition"
          v-tooltip="t.shell.transport.playheadPositionTitle"
          @focus="emit('bbtFocus')"
          @input="emit('updateBbtDraft', ($event.target as HTMLInputElement).value)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="emit('bbtBlur')"
        />
      </div>
      <div class="time-register time-secondary">
        <span class="time-cap">{{ t.shell.transport.time }}</span>
        <span class="position-seconds">{{ positionSeconds.toFixed(2) }}s</span>
      </div>
    </div>

    <span class="meter-frame">
      <LevelMeter :bridge="bridge" :width="120" :height="36" />
    </span>
  </footer>
</template>

<style scoped src="@/ui/shell/transport-bar.css"></style>

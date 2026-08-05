<script setup lang="ts">
import { computed, ref } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import type { useMidiRecording } from '@/composables/useMidiRecording';
import type { useRecording } from '@/composables/useRecording';
import type { RecordingInputDeviceOption } from '@/composables/useRecordingControls';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';

type Recording = ReturnType<typeof useRecording>;
type MidiRecording = ReturnType<typeof useMidiRecording>;
type CustomVoiceChangerPreset = Exclude<RealtimeVoiceChangerConfigInput, string>;

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
  metronomeVolume: number;
  positionSeconds: number;
  recording: Recording;
  recordingInputDeviceOptions: readonly RecordingInputDeviceOption[];
  midiRecording: MidiRecording;
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
  midiInputQuantizeChange: [denominator: number];
  nudgeByBar: [direction: -1 | 1];
  recordInputDeviceChange: [deviceId: string];
  recordSourceChange: [source: 'input' | 'output'];
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
  metronomeVolumeChange: [value: number];
  toggleRecord: [];
  updateBbtDraft: [value: string];
  updateRecordMenuOpen: [open: boolean];
  updateTempoInput: [value: number];
}>();

const { t } = useI18n();
const recordingOperationState = computed(
  () => props.recording.state?.value ?? (props.recording.isRecording.value ? 'recording' : 'idle'),
);

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

const voiceChangerOptions = computed(() => [
  { value: 'off', label: t.value.shell.transport.voiceChangerOff },
  { value: 'neutral-monitor', label: t.value.shell.transport.voiceChangerNeutral },
  { value: 'bright-idol', label: t.value.shell.transport.voiceChangerBright },
  { value: 'soft-whisper', label: t.value.shell.transport.voiceChangerSoft },
  { value: 'deep-narrator', label: t.value.shell.transport.voiceChangerDeep },
  { value: 'robot-mascot', label: t.value.shell.transport.voiceChangerRobot },
  { value: 'dark-villain', label: t.value.shell.transport.voiceChangerDark },
  { value: 'custom-json', label: t.value.shell.transport.voiceChangerCustom },
]);

const recordingSourceOptions = computed(() => [
  { value: 'input', label: t.value.shell.transport.recordSourceInput },
  { value: 'output', label: t.value.shell.transport.recordSourceOutput },
]);

const midiInputQuantizeOptions = computed(() => [
  { value: 0, label: t.value.shell.transport.midiInputQuantizeOff },
  { value: 4, label: t.value.shell.transport.midiInputQuantizeQuarter },
  { value: 8, label: t.value.shell.transport.midiInputQuantizeEighth },
  { value: 16, label: t.value.shell.transport.midiInputQuantizeSixteenth },
  { value: 32, label: t.value.shell.transport.midiInputQuantizeThirtySecond },
]);

const midiCycleRecordModeOptions = computed(() => [
  { value: 'takes', label: t.value.shell.transport.midiCycleRecordTakes },
  { value: 'overdub', label: t.value.shell.transport.midiCycleRecordOverdub },
  { value: 'keep-last', label: t.value.shell.transport.midiCycleRecordKeepLast },
  { value: 'overwrite', label: t.value.shell.transport.midiCycleRecordOverwrite },
]);

const midiCycleRecordMode = computed(() => props.midiRecording.cycleRecordMode?.value ?? 'takes');

function setMidiCycleRecordMode(value: string | number): void {
  if (props.midiRecording.cycleRecordMode !== undefined) {
    props.midiRecording.cycleRecordMode.value = String(
      value,
    ) as typeof props.midiRecording.cycleRecordMode.value;
  }
}

const customVoiceOpen = ref(false);
const customVoiceJson = ref('{\n  "schemaVersion": 1,\n  "macros": {},\n  "dsp": {}\n}');
const customVoiceError = ref('');
const voiceChangerSelectValue = computed(() =>
  typeof props.recording.voiceChangerPreset.value === 'string'
    ? props.recording.voiceChangerPreset.value
    : 'custom-json',
);
const showCustomVoiceEditor = computed(
  () => customVoiceOpen.value || typeof props.recording.voiceChangerPreset.value === 'object',
);

function onVoiceChangerChange(value: string | number): void {
  const next = String(value);
  if (next === 'custom-json') {
    customVoiceOpen.value = true;
    customVoiceError.value = '';
    return;
  }
  customVoiceOpen.value = false;
  customVoiceError.value = '';
  props.recording.setVoiceChangerPreset(next as Recording['voiceChangerPreset']['value']);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onApplyCustomVoicePreset(): void {
  customVoiceError.value = '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(customVoiceJson.value);
  } catch {
    customVoiceError.value = t.value.shell.transport.voiceChangerJsonInvalid;
    return;
  }
  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    ('macros' in parsed && !isPlainObject(parsed.macros)) ||
    ('dsp' in parsed && !isPlainObject(parsed.dsp))
  ) {
    customVoiceError.value = t.value.shell.transport.voiceChangerJsonInvalid;
    return;
  }
  props.recording.setVoiceChangerPreset(parsed as unknown as CustomVoiceChangerPreset);
}

function onRetuneInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  props.recording.setStreamingRetuneSemitones(Number.isFinite(value) ? value : 0);
}
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
          :disabled="
            !handle ||
            (recordingOperationState !== 'idle' && recordingOperationState !== 'recording') ||
            (recordingOperationState === 'idle' && recording.armedTrackId.value === null)
          "
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
          <label class="bar-field">
            {{ t.shell.transport.recordSource }}
            <SelectMenu
              :model-value="recording.captureSource.value"
              :options="recordingSourceOptions"
              size="sm"
              :disabled="recording.isRecording.value"
              :aria-label="t.shell.transport.recordSource"
              @change="emit('recordSourceChange', $event === 'output' ? 'output' : 'input')"
            />
          </label>
          <label class="bar-field">
            {{ t.shell.transport.inputDevice }}
            <SelectMenu
              :model-value="recording.inputDeviceId.value"
              :options="recordingInputDeviceOptions"
              size="sm"
              :disabled="recording.isRecording.value || recording.captureSource.value === 'output'"
              :aria-label="t.shell.transport.inputDevice"
              @change="emit('recordInputDeviceChange', String($event))"
            />
          </label>
          <ToggleButton
            :model-value="recording.monitorEnabled.value"
            :label="t.shell.transport.monitorInput"
            size="sm"
            :disabled="recording.captureSource.value === 'output'"
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
          <label class="bar-field">
            {{ t.shell.transport.midiInputQuantize }}
            <SelectMenu
              :model-value="midiRecording.inputQuantizeDenominator.value"
              :options="midiInputQuantizeOptions"
              size="sm"
              :disabled="midiRecording.isRecording.value"
              :aria-label="t.shell.transport.midiInputQuantize"
              @change="emit('midiInputQuantizeChange', Number($event))"
            />
          </label>
          <label class="bar-field">
            {{ t.shell.transport.midiCycleRecordMode }}
            <SelectMenu
              :model-value="midiCycleRecordMode"
              :options="midiCycleRecordModeOptions"
              size="sm"
              :disabled="midiRecording.isRecording.value"
              :aria-label="t.shell.transport.midiCycleRecordMode"
              @change="setMidiCycleRecordMode($event)"
            />
          </label>
          <label class="bar-field">
            {{ t.shell.transport.voiceChanger }}
            <SelectMenu
              :model-value="voiceChangerSelectValue"
              :options="voiceChangerOptions"
              size="sm"
              :disabled="recording.isRecording.value || recording.captureSource.value === 'output'"
              :aria-label="t.shell.transport.voiceChanger"
              @change="onVoiceChangerChange"
            />
          </label>
          <div v-if="showCustomVoiceEditor" class="voice-json-field">
            <label>
              {{ t.shell.transport.voiceChangerJson }}
              <textarea
                v-model="customVoiceJson"
                rows="5"
                spellcheck="false"
                :disabled="recording.isRecording.value || recording.captureSource.value === 'output'"
                :aria-label="t.shell.transport.voiceChangerJson"
              />
            </label>
            <button
              type="button"
              :disabled="recording.isRecording.value || recording.captureSource.value === 'output'"
              @click="onApplyCustomVoicePreset"
            >
              {{ t.shell.transport.voiceChangerApply }}
            </button>
            <p v-if="customVoiceError" class="voice-json-error" role="alert">
              {{ customVoiceError }}
            </p>
          </div>
          <label class="bar-field">
            {{ t.shell.transport.retune }}
            <input
              class="num"
              type="number"
              min="-24"
              max="24"
              step="1"
              :value="recording.streamingRetuneSemitones.value"
              :disabled="recording.isRecording.value || recording.captureSource.value === 'output'"
              :aria-label="t.shell.transport.retune"
              @change="onRetuneInput"
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
      <label class="metronome-volume" :aria-label="t.shell.transport.metronomeVolume">
        <input
          class="metronome-volume-input"
          :value="metronomeVolume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :disabled="!handle"
          @input="emit('metronomeVolumeChange', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
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
          size="12"
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

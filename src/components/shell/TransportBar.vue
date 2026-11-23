<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import TransportBbtField from '@/components/shell/TransportBbtField.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import TransportSecondsText from '@/components/shell/TransportSecondsText.vue';
import type { useMidiRecording } from '@/composables/useMidiRecording';
import type { useRecording } from '@/composables/useRecording';
import type { RecordingInputDeviceOption } from '@/composables/useRecordingControls';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import {
  STREAMING_RETUNE_MAX_SEMITONES,
  STREAMING_RETUNE_MIN_SEMITONES,
} from '@/engine/streaming-retune';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { isImeComposing } from '@/ui/keyboard/ime';
import { readInputNumber, restoreInputValue } from '@/ui/numeric-input';
import {
  CUSTOM_VOICE_PRESET_TEMPLATE,
  parseCustomVoicePreset,
} from '@/ui/shell/custom-voice-preset';

type Recording = ReturnType<typeof useRecording>;
type MidiRecording = ReturnType<typeof useMidiRecording>;

const props = defineProps<{
  autoPunchEnabled: boolean;
  /** Playhead bar.beat readout; a getter so only this bar re-renders per frame. */
  readBbtDisplay: () => string;
  bridge: MeterBridge | null;
  canRecord: boolean;
  countInChoices: readonly { value: number }[];
  handle: EngineHandle | null;
  hasLocatorWindow: boolean;
  isCountingIn: boolean;
  isPlaying: boolean;
  isRecording: boolean;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  /** Playhead seconds; a getter so only this bar re-renders per frame. */
  readPositionSeconds: () => number;
  recording: Recording;
  recordingInputDeviceOptions: readonly RecordingInputDeviceOption[];
  midiRecording: MidiRecording;
  recordMenuOpen: boolean;
  storeInitialized: boolean;
  tempoInput: number;
}>();

const emit = defineEmits<{
  applyTempo: [];
  cancelTempoInput: [];
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

const loadBlocked = computed(() =>
  firstBlock([!props.storeInitialized, t.value.reasons.projectLoading]),
);
const engineBlocked = computed(() =>
  firstBlock(loadBlocked.value, [!props.handle, t.value.reasons.engineOff]),
);
// A take is interpreted with the loop it plays through, so the loop is fixed while one records.
const loopEditBlocked = computed(() =>
  firstBlock(loadBlocked.value, [props.isRecording, t.value.reasons.recording]),
);
const stopBlocked = computed(() =>
  firstBlock(engineBlocked.value, [!props.isPlaying, t.value.shell.transport.reasons.notPlaying]),
);
const recordBlocked = computed(() => {
  if (props.isRecording) return engineBlocked.value;
  const state = recordingOperationState.value;
  return firstBlock(
    engineBlocked.value,
    [state !== 'idle' && state !== 'recording', t.value.shell.transport.reasons.recorderBusy],
    [state === 'idle' && !props.canRecord, t.value.reasons.noArmedTrack],
  );
});
const metronomeVolumeBlocked = computed(() =>
  firstBlock(loadBlocked.value, [
    !props.metronomeEnabled,
    t.value.shell.transport.reasons.metronomeOff,
  ]),
);

// Recording settings: audio-take options lock while a take runs; input-only options cascade from Source.
const audioTakeBlocked = computed(() =>
  firstBlock([props.recording.isRecording.value, t.value.reasons.recording]),
);
const inputOnlyReason = computed(() =>
  firstBlock([
    props.recording.captureSource.value === 'output',
    t.value.shell.transport.reasons.outputSource,
  ]),
);
const inputSettingBlocked = computed(() =>
  firstBlock(audioTakeBlocked.value, inputOnlyReason.value),
);
const midiTakeBlocked = computed(() =>
  firstBlock([props.midiRecording.isRecording.value, t.value.reasons.recording]),
);
const autoPunchBlocked = computed(() =>
  firstBlock([!props.hasLocatorWindow, t.value.reasons.noLocators]),
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
  { value: 'neutralMonitor', label: t.value.shell.transport.voiceChangerNeutral },
  { value: 'brightIdol', label: t.value.shell.transport.voiceChangerBright },
  { value: 'softWhisper', label: t.value.shell.transport.voiceChangerSoft },
  { value: 'deepNarrator', label: t.value.shell.transport.voiceChangerDeep },
  { value: 'robotMascot', label: t.value.shell.transport.voiceChangerRobot },
  { value: 'darkVillain', label: t.value.shell.transport.voiceChangerDark },
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

/** Enter commits the position by blurring, unless it confirms an IME conversion. */
function onBbtEnter(event: KeyboardEvent): void {
  if (isImeComposing(event)) return;
  (event.target as HTMLInputElement).blur();
}

function setMidiCycleRecordMode(value: string | number): void {
  if (props.midiRecording.cycleRecordMode !== undefined) {
    props.midiRecording.cycleRecordMode.value = String(
      value,
    ) as typeof props.midiRecording.cycleRecordMode.value;
  }
}

const customVoiceOpen = ref(false);
const customVoiceJson = ref(CUSTOM_VOICE_PRESET_TEMPLATE);
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

async function onApplyCustomVoicePreset(): Promise<void> {
  customVoiceError.value = '';
  try {
    const preset = parseCustomVoicePreset(await ensureWasm(), customVoiceJson.value);
    if (preset === null) {
      customVoiceError.value = t.value.shell.transport.voiceChangerJsonInvalid;
      return;
    }
    props.recording.setVoiceChangerPreset(preset);
  } catch (err) {
    customVoiceError.value = describeError(err, t.value.notices.errors);
  }
}

function onRetuneInput(event: Event): void {
  const value = readInputNumber(event);
  if (value === null) {
    restoreInputValue(event, props.recording.streamingRetuneSemitones.value);
    return;
  }
  props.recording.setStreamingRetuneSemitones(value);
}

function onTempoInput(event: Event): void {
  const tempo = readInputNumber(event);
  if (tempo !== null) emit('updateTempoInput', tempo);
}

/** A blank tempo commits nothing: the draft goes back to the committed tempo. */
async function onTempoChange(event: Event): Promise<void> {
  if (readInputNumber(event) !== null) {
    emit('applyTempo');
    return;
  }
  emit('cancelTempoInput');
  await nextTick();
  restoreInputValue(event, props.tempoInput);
}

function onMetronomeVolumeInput(event: Event): void {
  const volume = readInputNumber(event);
  if (volume !== null) emit('metronomeVolumeChange', volume);
}
</script>

<template>
  <footer class="transport-bar" :aria-label="t.shell.transport.label">
    <div class="transport-cluster" role="group" :aria-label="t.shell.transport.label">
      <button
        type="button"
        class="transport-nav press-feedback"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.goToStart"
        v-tooltip="{ text: t.shell.transport.goToStartTitle, shortcut: 'transport.toStart', reason: loadBlocked }"
        @click="emit('seekToStart')"
      >
        <TransportIcon name="to-start" />
      </button>
      <button
        type="button"
        class="transport-nav press-feedback"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.nudgeBack"
        v-tooltip="{ text: t.shell.transport.nudgeBackTitle, shortcut: 'transport.nudgeBack', reason: loadBlocked }"
        @click="emit('nudgeByBar', -1)"
      >
        <TransportIcon name="rewind" />
      </button>
      <button
        type="button"
        class="transport-nav press-feedback"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.nudgeForward"
        v-tooltip="{ text: t.shell.transport.nudgeForwardTitle, shortcut: 'transport.nudgeForward', reason: loadBlocked }"
        @click="emit('nudgeByBar', 1)"
      >
        <TransportIcon name="forward" />
      </button>
      <button
        type="button"
        class="transport-nav press-feedback"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.goToEnd"
        v-tooltip="{ text: t.shell.transport.goToEndTitle, shortcut: 'transport.toEnd', reason: loadBlocked }"
        @click="emit('seekToEnd')"
      >
        <TransportIcon name="to-end" />
      </button>
      <span class="cluster-divider" aria-hidden="true" />
      <button
        type="button"
        class="transport-key cycle press-feedback"
        :class="{ active: loopEnabled }"
        :disabled="!!loopEditBlocked"
        :aria-label="t.shell.transport.cycle"
        :aria-pressed="loopEnabled"
        v-tooltip="{
          text: t.shell.transport.cycleTitle,
          shortcut: 'transport.toggleLoop',
          reason: loopEditBlocked,
        }"
        @click="emit('toggleLoop')"
      >
        <TransportIcon name="cycle" />
      </button>
      <button
        type="button"
        class="transport-key stop press-feedback"
        :disabled="!!stopBlocked"
        :aria-label="t.shell.transport.stop"
        v-tooltip="{
          text: t.shell.transport.stopTitle,
          shortcut: 'transport.togglePlayback',
          reason: stopBlocked,
        }"
        @click="emit('stopPlayback')"
      >
        <TransportIcon name="stop" />
      </button>
      <button
        type="button"
        class="transport-key play press-feedback"
        :class="{ active: isPlaying, 'live-glow': isPlaying }"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.play"
        :aria-pressed="isPlaying"
        v-tooltip="{
          text: handle ? t.shell.transport.playTitle : t.shell.transport.playBootTitle,
          shortcut: 'transport.togglePlayback',
          reason: loadBlocked,
        }"
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
          class="transport-key record-button press-feedback"
          :class="{
            recording: isRecording,
            'counting-in': isCountingIn,
          }"
          :aria-label="t.shell.transport.record"
          :aria-pressed="isRecording"
          :disabled="!!recordBlocked"
          v-tooltip="{
            text: isRecording
              ? t.shell.transport.recordStopTitle
              : t.shell.transport.recordStartTitle,
            shortcut: 'transport.toggleRecord',
            reason: recordBlocked,
          }"
          @click="emit('toggleRecord')"
        >
          <TransportIcon name="record" />
        </button>
        <button
          type="button"
          class="record-settings press-feedback"
          :aria-label="t.shell.transport.recordingSettings"
          aria-haspopup="true"
          :aria-expanded="recordMenuOpen"
          v-tooltip="t.shell.transport.recordingSettings"
          @click="emit('updateRecordMenuOpen', !recordMenuOpen)"
        >
          <TransportIcon name="chevron-down" />
        </button>
        <Transition name="pop">
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
                :title="t.shell.transport.recordSourceTitle"
                :reason="audioTakeBlocked"
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
                :reason="inputSettingBlocked"
                :aria-label="t.shell.transport.inputDevice"
                @change="emit('recordInputDeviceChange', String($event))"
              />
            </label>
            <ToggleButton
              :model-value="recording.monitorEnabled.value"
              :label="t.shell.transport.monitorInput"
              size="sm"
              :title="t.shell.transport.monitorInputTitle"
              :reason="inputOnlyReason"
              @update:model-value="recording.setMonitor($event)"
            />
            <label class="bar-field">
              {{ t.shell.transport.countIn }}
              <SelectMenu
                :model-value="recording.countInBars.value"
                :options="countInOptions"
                size="sm"
                :title="t.shell.transport.countInTitle"
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
                :title="t.shell.transport.midiInputQuantizeTitle"
                :reason="midiTakeBlocked"
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
                :title="t.shell.transport.midiCycleRecordModeTitle"
                :reason="midiTakeBlocked"
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
                :title="t.shell.transport.voiceChangerTitle"
                :reason="inputSettingBlocked"
                :aria-label="t.shell.transport.voiceChanger"
                @change="onVoiceChangerChange"
              />
            </label>
            <div v-if="showCustomVoiceEditor" class="voice-json-field view-enter">
              <label>
                {{ t.shell.transport.voiceChangerJson }}
                <textarea
                  v-model="customVoiceJson"
                  rows="5"
                  spellcheck="false"
                  :disabled="!!inputSettingBlocked"
                  :aria-label="t.shell.transport.voiceChangerJson"
                  v-tooltip="{ reason: inputSettingBlocked }"
                />
              </label>
              <button
                type="button"
                :disabled="!!inputSettingBlocked"
                v-tooltip="{ reason: inputSettingBlocked }"
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
                :min="STREAMING_RETUNE_MIN_SEMITONES"
                :max="STREAMING_RETUNE_MAX_SEMITONES"
                step="1"
                :value="recording.streamingRetuneSemitones.value"
                :disabled="!!inputSettingBlocked"
                :aria-label="t.shell.transport.retune"
                v-tooltip="{ text: t.shell.transport.retuneTitle, reason: inputSettingBlocked }"
                @change="onRetuneInput"
              />
            </label>
            <ToggleButton
              :model-value="autoPunchEnabled"
              :label="t.shell.transport.autoPunch"
              size="sm"
              :title="t.shell.transport.autoPunchReadyTitle"
              :reason="autoPunchBlocked"
              @update:model-value="emit('toggleAutoPunch')"
            />
          </div>
        </Transition>
        <Transition name="fade">
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
        </Transition>
      </div>
    </div>

    <div class="transport-module" role="group" :aria-label="t.shell.transport.tempoGroup">
      <span class="module-cap">{{ t.shell.transport.tempo }}</span>
      <label class="tempo-field">
        <input
          :value="tempoInput"
          type="number"
          min="20"
          max="300"
          step="1"
          class="tempo-input"
          :disabled="!!loadBlocked"
          :aria-label="t.shell.transport.tempoLabel"
          v-tooltip="{ text: t.shell.transport.tempoTitle, reason: loadBlocked }"
          @input="onTempoInput"
          @change="onTempoChange"
        />
        <span class="tempo-unit" aria-hidden="true">BPM</span>
      </label>
      <button
        type="button"
        class="click-toggle press-feedback"
        :class="{ active: metronomeEnabled }"
        :disabled="!!loadBlocked"
        :aria-label="t.shell.transport.metronome"
        :aria-pressed="metronomeEnabled"
        v-tooltip="{ text: t.shell.transport.metronomeTitle, reason: loadBlocked }"
        @click="emit('toggleMetronome')"
      >
        <TransportIcon name="metronome" />
      </button>
      <label class="metronome-volume">
        <input
          class="metronome-volume-input"
          :value="metronomeVolume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :disabled="!!metronomeVolumeBlocked"
          :aria-label="t.shell.transport.metronomeVolume"
          v-tooltip="{ text: t.shell.transport.metronomeVolume, reason: metronomeVolumeBlocked }"
          @input="onMetronomeVolumeInput"
        />
      </label>
    </div>

    <div class="transport-module" role="group" :aria-label="t.shell.transport.locatorsGroup">
      <span class="module-cap">{{ t.shell.transport.locators }}</span>
      <div class="locator-group">
        <button
          type="button"
          class="transport-nav locator press-feedback"
          :disabled="!!loopEditBlocked"
          :aria-label="t.shell.transport.setLeftLocator"
          v-tooltip="{
            text: t.shell.transport.setLeftLocatorTitle,
            shortcut: 'transport.setLeftLocator',
            reason: loopEditBlocked,
          }"
          @click="emit('setLeftLocator')"
        >
          L
        </button>
        <button
          type="button"
          class="transport-nav locator press-feedback"
          :disabled="!!loopEditBlocked"
          :aria-label="t.shell.transport.setRightLocator"
          v-tooltip="{
            text: t.shell.transport.setRightLocatorTitle,
            shortcut: 'transport.setRightLocator',
            reason: loopEditBlocked,
          }"
          @click="emit('setRightLocator')"
        >
          R
        </button>
      </div>
      <button
        v-if="autoPunchEnabled"
        type="button"
        class="punch-indicator animate-pop"
        :aria-label="t.shell.transport.autoPunchArmed"
        v-tooltip="t.shell.transport.autoPunchArmedTitle"
        @click="emit('toggleAutoPunch')"
      >
        {{ t.shell.transport.punch }}
      </button>
    </div>

    <span class="bar-spacer" />

    <div class="time-display" :class="{ playing: isPlaying, recording: isRecording }">
      <div class="time-register time-primary">
        <span class="time-cap">{{ t.shell.transport.bars }}</span>
        <TransportBbtField
          class="position-bbt"
          size="12"
          :read-value="readBbtDisplay"
          :aria-label="t.shell.transport.playheadPosition"
          v-tooltip="t.shell.transport.playheadPositionTitle"
          @focus="emit('bbtFocus')"
          @input="emit('updateBbtDraft', ($event.target as HTMLInputElement).value)"
          @keydown.enter="onBbtEnter"
          @blur="emit('bbtBlur')"
        />
      </div>
      <div class="time-register time-secondary" v-tooltip="t.shell.transport.timeTitle">
        <span class="time-cap">{{ t.shell.transport.time }}</span>
        <TransportSecondsText class="position-seconds" :read-seconds="readPositionSeconds" />
      </div>
    </div>

    <span class="meter-frame">
      <LevelMeter :bridge="bridge" :width="120" :height="36" />
    </span>
  </footer>
</template>

<style scoped src="@/ui/shell/transport-bar.css"></style>

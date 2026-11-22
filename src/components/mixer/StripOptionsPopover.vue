<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { clamp } from '@/lib/math';
import {
  currentStrip,
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
} from '@/project/command/mixer-internal';
import {
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripInputTrim,
  setStripPanLaw,
  setStripPanMode,
  setStripPolarityInvert,
  setStripWidth,
} from '@/project/commands';
import {
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_STRIP_WIDTH,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_WIDTH,
  type MixerStrip,
  PAN_LAW_IDS,
  PAN_MODE_IDS,
  type PanModeId,
} from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type MidiLearnBusStripControlParam,
  type MidiLearnStripControlParam,
  midiLearnBusStripControlTargetId,
  midiLearnStripControlTargetId,
} from '@/ui/midi/midi-learn';
import { formatDb, formatPan } from '@/ui/mixer/db-scale';
import type { PanLaw } from '@/wasm/index.js';
import NumericReadout from './NumericReadout.vue';

/**
 * Strip-local DSP options popover: a gear button that opens a menu of pre-fader
 * input trim, stereo width, per-channel polarity invert and — on track lanes —
 * channel alignment delay plus the pan-law / pan-mode shaping (including the
 * dual-pan left/right sliders) on track/group and return-bus strips. The button
 * lights when any control deviates from neutral. The popover dismisses on an
 * outside press.
 *
 * Regular track lanes expose the full set. Group and return-bus strips expose
 * panner controls but omit channel delay; the master strip keeps the generic
 * input/width/polarity controls only.
 */

const props = defineProps<{
  /** Strip target: a track, master, or send/return bus. */
  target: MixerStripTarget;
  /** Strip display name (for the accessible button label). */
  name: string;
}>();

const store = useProjectStore();
const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

const strip = computed<MixerStrip>(() => currentStrip(store, props.target));

/** Surround return buses do not expose the engine's stereo panner or width stage. */
const isSurroundBus = computed(() => {
  const target = props.target;
  if (!isMixerBusStripTarget(target)) return false;
  const bus = store.mixer.buses.find((entry) => entry.id === mixerBusIdFromTarget(target));
  return bus?.channelLayout === '5.1' || bus?.channelLayout === '7.1';
});

/** Surround buses have no stereo panner, so stereo shaping is unavailable on them. */
const stereoBlocked = computed(() =>
  firstBlock([isSurroundBus.value, t.value.shell.mixer.strip.stereoControlsUnavailable]),
);

/** Pan law/mode controls are available on track/group and return-bus strips. */
const canPannerOptions = computed(() => props.target !== 'master');
/** Channel alignment delay is a regular track-lane control, not a group bus. */
const canChannelDelay = computed(
  () =>
    typeof props.target === 'number' &&
    store.tracks.find((track) => track.id === props.target)?.kind !== 'group',
);

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
const panLaw = computed<PanLaw>(() => strip.value.panLaw ?? DEFAULT_PAN_LAW);
/** Current pan mode (default when unset). */
const panMode = computed<PanModeId>(() => strip.value.panMode ?? DEFAULT_PAN_MODE);
/** Left/right pan positions for dual-pan mode (neutral stereo when unset). */
const dualPanLeft = computed(() => strip.value.dualPan?.left ?? -1);
const dualPanRight = computed(() => strip.value.dualPan?.right ?? 1);

/** Pan law options for the selector (labels from i18n, value = PanLaw). */
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
  const value = Number.isFinite(raw) ? clamp(raw, MIN_INPUT_TRIM_DB, MAX_INPUT_TRIM_DB) : 0;
  setStripInputTrim(props.target, value, { commit });
}

function onWidthInput(event: Event, commit: boolean): void {
  if (isSurroundBus.value) return;
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw)
    ? clamp(raw, MIN_STRIP_WIDTH, MAX_STRIP_WIDTH)
    : DEFAULT_STRIP_WIDTH;
  setStripWidth(props.target, value, { commit });
}

/** Commits a bounded value entered through the adjacent numeric readout. */
function onInputTrimValue(value: number): void {
  setStripInputTrim(props.target, value);
}

/** Commits a bounded width entered through the adjacent numeric readout. */
function onWidthValue(value: number): void {
  if (isSurroundBus.value) return;
  setStripWidth(props.target, value);
}

function onPolarityToggle(channel: 'left' | 'right'): void {
  const left = channel === 'left' ? !polarityLeft.value : polarityLeft.value;
  const right = channel === 'right' ? !polarityRight.value : polarityRight.value;
  setStripPolarityInvert(props.target, left, right);
}

function onChannelDelayInput(event: Event): void {
  if (typeof props.target !== 'number') return;
  const raw = Number.parseInt((event.target as HTMLInputElement).value, 10);
  const samples = Number.isFinite(raw) ? clamp(raw, 0, MAX_CHANNEL_DELAY_SAMPLES) : 0;
  setStripChannelDelaySamples(props.target, samples);
}

function onPanLawChange(value: string): void {
  if (props.target === 'master' || isSurroundBus.value) return;
  const law = PAN_LAW_IDS.find((id) => id === value);
  if (law !== undefined) setStripPanLaw(props.target, law);
}

function onPanModeChange(value: string): void {
  if (props.target === 'master' || isSurroundBus.value) return;
  setStripPanMode(props.target, value as PanModeId);
}

/** Updates or commits a dual-pan slider edit, keeping the other channel intact. */
function onDualPanInput(channel: 'left' | 'right', event: Event, commit: boolean): void {
  if (props.target === 'master' || isSurroundBus.value) return;
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw) ? clamp(raw, -1, 1) : 0;
  const left = channel === 'left' ? value : dualPanLeft.value;
  const right = channel === 'right' ? value : dualPanRight.value;
  setStripDualPan(props.target, left, right, { commit });
}

function learnTargetId(param: MidiLearnStripControlParam): string {
  if (typeof props.target !== 'number' && props.target !== 'master') {
    return midiLearnBusStripControlTargetId(
      props.target.slice('bus:'.length),
      param as MidiLearnBusStripControlParam,
    );
  }
  return midiLearnStripControlTargetId(props.target, param);
}

function learnState(param: MidiLearnStripControlParam): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn) return undefined;
  if (
    isSurroundBus.value &&
    (param === 'width' ||
      param === 'panLaw' ||
      param === 'panMode' ||
      param === 'dualPanLeft' ||
      param === 'dualPanRight')
  ) {
    return undefined;
  }
  if (
    isMixerBusStripTarget(props.target) &&
    !(
      param === 'inputTrimDb' ||
      param === 'width' ||
      param === 'polarityLeft' ||
      param === 'polarityRight'
    )
  ) {
    return undefined;
  }
  const id = learnTargetId(param);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearn(param: MidiLearnStripControlParam): void {
  midiLearn?.armId(learnTargetId(param));
}

function onMidiForget(param: MidiLearnStripControlParam): void {
  midiLearn?.clearId(learnTargetId(param));
}

useOutsidePointerDown(
  optionsOpen,
  (target) => !!optionsMenu.value?.contains(target),
  () => {
    optionsOpen.value = false;
  },
);
</script>

<template>
  <div ref="optionsMenu" class="strip-options">
    <button
      type="button"
      class="strip-options-btn"
      :class="{ on: hasStripOptions }"
      v-tooltip="t.shell.mixer.strip.options"
      :aria-label="formatMessage(t.shell.mixer.strip.optionsNamed, { name: props.name })"
      aria-haspopup="menu"
      :aria-expanded="optionsOpen"
      @click="optionsOpen = !optionsOpen"
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
        stroke-width="1.3" aria-hidden="true">
        <circle cx="8" cy="8" r="2.1" />
        <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
      </svg>
    </button>
    <Transition name="pop">
    <div v-if="optionsOpen" class="strip-options-popover" role="menu">
      <p v-if="isSurroundBus" class="strip-options-note" role="note">
        {{ t.shell.mixer.strip.stereoControlsUnavailable }}
      </p>
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
          <NumericReadout
            class="strip-options-unit"
            :value="inputTrimDb"
            :min="MIN_INPUT_TRIM_DB"
            :max="MAX_INPUT_TRIM_DB"
            :step="0.1"
            :display="formatDb(inputTrimDb)"
            unit="dB"
            :ariaLabel="t.shell.mixer.strip.inputTrim"
            @change="onInputTrimValue"
          />
          <button
            v-if="learnState('inputTrimDb')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('inputTrimDb')"
            v-tooltip="
              learnState('inputTrimDb') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('inputTrimDb')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('inputTrimDb') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('inputTrimDb')"
          >
            ×
          </button>
        </span>
      </label>
      <label class="strip-options-row" :class="{ 'is-disabled': !!stereoBlocked }"
        v-tooltip="{ reason: stereoBlocked, placement: 'end' }">
        <span class="strip-options-label">{{ t.shell.mixer.strip.width }}</span>
        <span class="strip-options-field">
          <input
            type="range"
            :min="MIN_STRIP_WIDTH"
            :max="MAX_STRIP_WIDTH"
            :step="0.01"
            :value="stripWidth"
            :aria-label="t.shell.mixer.strip.width"
            :disabled="!!stereoBlocked"
            @input="onWidthInput($event, false)"
            @change="onWidthInput($event, true)"
          />
          <NumericReadout
            class="strip-options-unit"
            :value="stripWidth"
            :min="MIN_STRIP_WIDTH"
            :max="MAX_STRIP_WIDTH"
            :step="0.01"
            :display="stripWidth.toFixed(2)"
            :ariaLabel="t.shell.mixer.strip.width"
            :reason="stereoBlocked"
            @change="onWidthValue"
          />
          <button
            v-if="learnState('width')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('width')"
            v-tooltip="
              learnState('width') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('width')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('width') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('width')"
          >
            ×
          </button>
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
            v-if="learnState('polarityLeft')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('polarityLeft')"
            v-tooltip="
              learnState('polarityLeft') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('polarityLeft')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('polarityLeft') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('polarityLeft')"
          >
            ×
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
          <button
            v-if="learnState('polarityRight')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('polarityRight')"
            v-tooltip="
              learnState('polarityRight') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('polarityRight')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('polarityRight') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('polarityRight')"
          >
            ×
          </button>
        </span>
      </div>
      <label v-if="canChannelDelay" class="strip-options-row">
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
          <button
            v-if="learnState('channelDelaySamples')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('channelDelaySamples')"
            v-tooltip="
              learnState('channelDelaySamples') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('channelDelaySamples')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('channelDelaySamples') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('channelDelaySamples')"
          >
            ×
          </button>
        </span>
      </label>
      <div
        v-if="canPannerOptions"
        class="strip-options-row"
        :class="{ 'is-disabled': !!stereoBlocked }"
        v-tooltip="{ reason: stereoBlocked, placement: 'end' }"
      >
        <span class="strip-options-label">{{ t.shell.mixer.strip.panLaw }}</span>
        <span class="strip-options-field">
          <SelectMenu
            :model-value="panLaw"
            size="sm"
            :options="panLawOptions"
            :reason="stereoBlocked"
            :aria-label="t.shell.mixer.strip.panLaw"
            @change="onPanLawChange"
          />
          <button
            v-if="learnState('panLaw')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('panLaw')"
            v-tooltip="
              learnState('panLaw') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('panLaw')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('panLaw') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('panLaw')"
          >
            ×
          </button>
        </span>
      </div>
      <div
        v-if="canPannerOptions"
        class="strip-options-row"
        :class="{ 'is-disabled': !!stereoBlocked }"
        v-tooltip="{ reason: stereoBlocked, placement: 'end' }"
      >
        <span class="strip-options-label">{{ t.shell.mixer.strip.panMode }}</span>
        <span class="strip-options-field">
          <SelectMenu
            :model-value="panMode"
            size="sm"
            :options="panModeOptions"
            :reason="stereoBlocked"
            :aria-label="t.shell.mixer.strip.panMode"
            @change="onPanModeChange"
          />
          <button
            v-if="learnState('panMode')"
            type="button"
            class="strip-midi-learn"
            :class="learnState('panMode')"
            v-tooltip="
              learnState('panMode') === 'armed'
                ? t.shell.mixer.controls.midiLearnListening
                : t.shell.mixer.controls.midiLearn
            "
            :aria-label="t.shell.mixer.controls.midiLearn"
            @click="onMidiLearn('panMode')"
          >
            MIDI
          </button>
          <button
            v-if="learnState('panMode') === 'bound'"
            type="button"
            class="strip-midi-forget"
            v-tooltip="t.shell.mixer.controls.midiForget"
            :aria-label="t.shell.mixer.controls.midiForget"
            @click="onMidiForget('panMode')"
          >
            ×
          </button>
        </span>
      </div>
      <template v-if="canPannerOptions && panMode === 'dualPan'">
        <label class="strip-options-row" :class="{ 'is-disabled': !!stereoBlocked }"
        v-tooltip="{ reason: stereoBlocked, placement: 'end' }">
          <span class="strip-options-label">{{ t.shell.mixer.strip.dualPanLeft }}</span>
          <span class="strip-options-field">
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              :value="dualPanLeft"
              :aria-label="t.shell.mixer.strip.dualPanLeft"
              :disabled="!!stereoBlocked"
              @input="onDualPanInput('left', $event, false)"
              @change="onDualPanInput('left', $event, true)"
            />
            <span class="strip-options-unit">{{ formatPan(dualPanLeft) }}</span>
            <button
              v-if="learnState('dualPanLeft')"
              type="button"
              class="strip-midi-learn"
              :class="learnState('dualPanLeft')"
              v-tooltip="
                learnState('dualPanLeft') === 'armed'
                  ? t.shell.mixer.controls.midiLearnListening
                  : t.shell.mixer.controls.midiLearn
              "
              :aria-label="t.shell.mixer.controls.midiLearn"
              @click="onMidiLearn('dualPanLeft')"
            >
              MIDI
            </button>
            <button
              v-if="learnState('dualPanLeft') === 'bound'"
              type="button"
              class="strip-midi-forget"
              v-tooltip="t.shell.mixer.controls.midiForget"
              :aria-label="t.shell.mixer.controls.midiForget"
              @click="onMidiForget('dualPanLeft')"
            >
              ×
            </button>
          </span>
        </label>
        <label class="strip-options-row" :class="{ 'is-disabled': !!stereoBlocked }"
        v-tooltip="{ reason: stereoBlocked, placement: 'end' }">
          <span class="strip-options-label">{{ t.shell.mixer.strip.dualPanRight }}</span>
          <span class="strip-options-field">
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              :value="dualPanRight"
              :aria-label="t.shell.mixer.strip.dualPanRight"
              :disabled="!!stereoBlocked"
              @input="onDualPanInput('right', $event, false)"
              @change="onDualPanInput('right', $event, true)"
            />
            <span class="strip-options-unit">{{ formatPan(dualPanRight) }}</span>
            <button
              v-if="learnState('dualPanRight')"
              type="button"
              class="strip-midi-learn"
              :class="learnState('dualPanRight')"
              v-tooltip="
                learnState('dualPanRight') === 'armed'
                  ? t.shell.mixer.controls.midiLearnListening
                  : t.shell.mixer.controls.midiLearn
              "
              :aria-label="t.shell.mixer.controls.midiLearn"
              @click="onMidiLearn('dualPanRight')"
            >
              MIDI
            </button>
            <button
              v-if="learnState('dualPanRight') === 'bound'"
              type="button"
              class="strip-midi-forget"
              v-tooltip="t.shell.mixer.controls.midiForget"
              :aria-label="t.shell.mixer.controls.midiForget"
              @click="onMidiForget('dualPanRight')"
            >
              ×
            </button>
          </span>
        </label>
      </template>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.strip-options {
  position: relative;
}

.strip-options-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
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
  transform-origin: top left;
}

.strip-options-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.strip-options-row.is-disabled {
  opacity: 0.62;
}

.strip-options-note {
  margin: 0 0 var(--sp-1);
  font: var(--fs-2xs) / 1.3 var(--font-sans);
  color: var(--text-4);
}

.strip-options-label {
  font: var(--fw-semibold) var(--fs-chrome-md) var(--font-sans);
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
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--control-edge), var(--inset-well);
  padding: 1px 4px;
}

.strip-options-unit {
  font: var(--fs-chrome-md) var(--font-sans);
  color: var(--text-4);
}

.strip-midi-learn,
.strip-midi-forget {
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

/* Listening for a MIDI message: a breathing halo until a control arrives. */
.strip-midi-learn.armed {
  --live-color: var(--accent);
  color: var(--surface-0);
  background: var(--accent);
  animation: live-glow 1.8s var(--ease-out) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .strip-midi-learn.armed {
    animation: none;
  }
}

.strip-midi-learn.bound {
  color: var(--accent);
}

.strip-midi-forget {
  width: 14px;
  padding: 0;
  color: var(--text-4);
}

.toggle {
  width: 16px;
  height: 14px;
  font: var(--fw-bold) var(--fs-chrome-lg) var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border: none;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-2) var(--ease-out),
    color var(--dur-2) var(--ease-out),
    transform var(--dur-1) var(--ease-out);
}

.toggle:active {
  transform: scale(0.9);
}

.toggle.on {
  color: var(--surface-0);
  background: var(--accent);
  animation: toggle-latch var(--dur-3) var(--ease-spring);
}
</style>

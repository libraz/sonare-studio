<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
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
  createDefaultStrip,
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
  type PanLawId,
  type PanModeId,
} from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatDb, formatPan } from '@/ui/mixer/db-scale';

/**
 * Strip-local DSP options popover: a gear button that opens a menu of pre-fader
 * input trim, stereo width, per-channel polarity invert and — on track lanes —
 * channel alignment delay plus the pan-law / pan-mode shaping (including the
 * dual-pan left/right sliders). The button lights when any control deviates
 * from neutral. The popover dismisses on an outside press.
 *
 * Track lanes expose the full set; the master strip omits the track-only
 * panner controls (channel delay, pan law/mode, dual pan).
 */

const props = defineProps<{
  /** Strip target: a track id or 'master'. */
  target: number | 'master';
  /** Strip display name (for the accessible button label). */
  name: string;
}>();

const store = useProjectStore();
const { t } = useI18n();

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  const track = store.tracks.find((entry) => entry.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

/** Panner detail controls are track-lane features (not the master strip). */
const canTrackPannerOptions = computed(() => typeof props.target === 'number');

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
  document.removeEventListener('pointerdown', onOptionsPointerDown, true);
});
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
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--control-edge), var(--inset-well);
  padding: 1px 4px;
}

.strip-options-unit {
  font: 8px var(--font-sans);
  color: var(--text-4);
}

.toggle {
  width: 16px;
  height: 14px;
  font: 700 9px var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border: none;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

.toggle.on {
  color: var(--surface-0);
  background: var(--accent);
}
</style>

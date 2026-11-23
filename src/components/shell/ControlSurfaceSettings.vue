<script setup lang="ts">
import { computed } from 'vue';
import type { ControlSurfaceHandle } from '@/composables/useControlSurface';
import {
  bankOffsetAfter,
  bankPagingSize,
  CONTROL_SURFACE_PROTOCOLS,
  type ControlSurfaceProtocol,
  sanitizeControlSurfaceSettings,
} from '@/project/control-surface';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { SURFACE_STRIP_COUNT } from '@/ui/midi/surface-protocol';
import { readInputNumber, restoreInputValue } from '@/ui/numeric-input';

/**
 * Control-surface settings of the MIDI-learn popover: protocol, ports, feedback,
 * bank size and bank paging. Every setter writes the whole record back to
 * `store.controlSurface`.
 */

const props = defineProps<{
  /** Control-surface ports and status; omitted when Web MIDI is unavailable. */
  surface?: ControlSurfaceHandle;
  /** Number of tracks the bank pages over. */
  trackCount: number;
}>();

const { t } = useI18n();
const store = useProjectStore();

/** Live surface settings; every setter writes the whole record back. */
const surfaceSettings = computed(() => store.controlSurface);

function updateSurface(patch: Partial<typeof store.controlSurface>): void {
  store.controlSurface = sanitizeControlSurfaceSettings({ ...store.controlSurface, ...patch });
}

function onBankSizeChange(event: Event): void {
  const bankSize = readInputNumber(event);
  if (bankSize === null) {
    restoreInputValue(event, surfaceSettings.value.bankSize);
    return;
  }
  updateSurface({ bankSize: Math.min(SURFACE_STRIP_COUNT, bankSize) });
}

const protocolChoices = computed(() =>
  CONTROL_SURFACE_PROTOCOLS.map((protocol) => ({
    value: protocol,
    label: t.value.shell.midiLearn.surfaceProtocols[protocol],
  })),
);

/** Human-readable description of which tracks the bank currently covers. */
const bankRange = computed(() => {
  const total = props.trackCount;
  if (total === 0) return '';
  const from = Math.min(total, surfaceSettings.value.bankOffset + 1);
  const to = Math.min(
    total,
    surfaceSettings.value.bankOffset + bankPagingSize(surfaceSettings.value),
  );
  return formatMessage(t.value.shell.midiLearn.surfaceBankRange, {
    from: String(from),
    to: String(to),
    total: String(total),
  });
});

/** Port and feedback settings only take effect under a surface protocol. */
const surfacePortBlocked = computed(() =>
  firstBlock([
    surfaceSettings.value.protocol === 'none',
    t.value.shell.midiLearn.reasons.noProtocol,
  ]),
);
const feedbackBlocked = computed(() =>
  firstBlock([!props.surface, t.value.reasons.noWebMidi], surfacePortBlocked.value, [
    surfaceSettings.value.outputPortId === null,
    t.value.shell.midiLearn.reasons.noOutput,
  ]),
);

const bankPrevBlocked = computed(() =>
  firstBlock(
    [props.trackCount === 0, t.value.reasons.noTrack],
    [surfaceSettings.value.bankOffset <= 0, t.value.shell.midiLearn.reasons.firstBank],
  ),
);
const bankNextBlocked = computed(() => {
  const surface = surfaceSettings.value;
  return firstBlock(
    [props.trackCount === 0, t.value.reasons.noTrack],
    [
      bankOffsetAfter('next', surface, props.trackCount) === surface.bankOffset,
      t.value.shell.midiLearn.reasons.lastBank,
    ],
  );
});

function moveBank(action: 'prev' | 'next'): void {
  updateSurface({
    bankOffset: bankOffsetAfter(action, surfaceSettings.value, props.trackCount),
  });
}
</script>

<template>
  <div class="ml-surface">
    <div class="ml-row-head ml-devices-head">
      <span class="ml-col-head">{{ t.shell.midiLearn.surface }}</span>
    </div>
    <label class="ml-field" v-tooltip="t.shell.midiLearn.surfaceProtocolTitle">
      <span>{{ t.shell.midiLearn.surfaceProtocol }}</span>
      <select
        class="ml-select"
        :value="surfaceSettings.protocol"
        @change="
          updateSurface({
            protocol: ($event.target as HTMLSelectElement).value as ControlSurfaceProtocol,
          })
        "
      >
        <option v-for="choice in protocolChoices" :key="choice.value" :value="choice.value">
          {{ choice.label }}
        </option>
      </select>
    </label>
    <template v-if="surface">
      <label
        class="ml-field"
        v-tooltip="{ text: t.shell.midiLearn.surfaceInputTitle, reason: surfacePortBlocked }"
      >
        <span>{{ t.shell.midiLearn.surfaceInput }}</span>
        <select
          class="ml-select ml-surface-input"
          :disabled="!!surfacePortBlocked"
          :value="surfaceSettings.inputPortId ?? ''"
          @change="
            updateSurface({
              inputPortId: ($event.target as HTMLSelectElement).value || null,
            })
          "
        >
          <option value="">{{ t.shell.midiLearn.surfacePortNone }}</option>
          <option v-for="port in surface.inputs.value" :key="port.id" :value="port.id">
            {{ port.name }}
          </option>
        </select>
      </label>
      <label
        class="ml-field"
        v-tooltip="{ text: t.shell.midiLearn.surfaceOutputTitle, reason: surfacePortBlocked }"
      >
        <span>{{ t.shell.midiLearn.surfaceOutput }}</span>
        <select
          class="ml-select ml-surface-output"
          :disabled="!!surfacePortBlocked"
          :value="surfaceSettings.outputPortId ?? ''"
          @change="
            updateSurface({
              outputPortId: ($event.target as HTMLSelectElement).value || null,
            })
          "
        >
          <option value="">{{ t.shell.midiLearn.surfacePortNone }}</option>
          <option v-for="port in surface.outputs.value" :key="port.id" :value="port.id">
            {{ port.name }}
          </option>
        </select>
      </label>
    </template>
    <label
      class="ml-field ml-field-check"
      v-tooltip="{ text: t.shell.midiLearn.surfaceFeedbackTitle, reason: feedbackBlocked }"
    >
      <input
        type="checkbox"
        class="ml-surface-feedback"
        :disabled="!!feedbackBlocked"
        :checked="surfaceSettings.feedback"
        @change="updateSurface({ feedback: ($event.target as HTMLInputElement).checked })"
      />
      <span>{{ t.shell.midiLearn.surfaceFeedback }}</span>
    </label>
    <label class="ml-field" v-tooltip="t.shell.midiLearn.surfaceBankSizeTitle">
      <span>{{ t.shell.midiLearn.surfaceBankSize }}</span>
      <input
        type="number"
        class="ml-number ml-surface-bank-size"
        min="1"
        :max="SURFACE_STRIP_COUNT"
        :value="surfaceSettings.bankSize"
        @change="onBankSizeChange"
      />
    </label>
    <div class="ml-field ml-bank-nav">
      <span>{{ t.shell.midiLearn.surfaceBank }}</span>
      <button
        type="button"
        class="ml-btn ml-bank-step"
        :aria-label="t.shell.midiLearn.surfaceBankPrev"
        :disabled="!!bankPrevBlocked"
        v-tooltip="{ text: t.shell.midiLearn.surfaceBankPrev, reason: bankPrevBlocked }"
        @click="moveBank('prev')"
      >
        ◀
      </button>
      <button
        type="button"
        class="ml-btn ml-bank-step"
        :aria-label="t.shell.midiLearn.surfaceBankNext"
        :disabled="!!bankNextBlocked"
        v-tooltip="{ text: t.shell.midiLearn.surfaceBankNext, reason: bankNextBlocked }"
        @click="moveBank('next')"
      >
        ▶
      </button>
      <span class="ml-bank-range">{{ bankRange }}</span>
    </div>
    <p class="ml-surface-note">{{ t.shell.midiLearn.surfaceNote }}</p>
    <p v-if="surfaceSettings.protocol === 'hui'" class="ml-surface-note ml-surface-warning">
      {{ t.shell.midiLearn.surfaceHuiNote }}
    </p>
  </div>
</template>

<style scoped src="./midi-learn-panel.css"></style>

<style scoped>
.ml-surface {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
}

.ml-field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ml-field > span:first-child {
  flex: 1;
  min-width: 0;
}

.ml-field-check {
  justify-content: flex-start;
}

.ml-field-check > span {
  flex: 1;
}

.ml-select,
.ml-number {
  min-width: 0;
  width: 11rem;
  font-size: var(--fs-xs);
  font-family: inherit;
}

.ml-number {
  width: 4rem;
}

.ml-bank-nav {
  gap: var(--sp-1);
}

.ml-bank-step {
  padding: 0 var(--sp-2);
  line-height: 1.6;
}

.ml-bank-range {
  flex: 2;
  text-align: right;
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
}

.ml-bank-step:disabled {
  opacity: 0.4;
  cursor: default;
}

.ml-surface-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.ml-surface-warning {
  color: var(--warning, var(--text-3));
}


.ml-select:disabled,
.ml-field-check input:disabled {
  opacity: 0.5;
}
</style>

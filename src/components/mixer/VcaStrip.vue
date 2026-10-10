<script setup lang="ts">
import { computed, inject } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import {
  removeVcaGroup,
  renameVcaGroup,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
} from '@/project/commands';
import type { VcaGroup } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type MidiLearnVcaParam, midiLearnVcaTargetId } from '@/ui/midi/midi-learn';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb } from '@/ui/mixer/db-scale';
import MixerFader from './MixerFader.vue';
import NumericReadout from './NumericReadout.vue';

/**
 * Compact strip for a VCA control group: a name header, the offset fader, and a
 * remove button. A VCA carries no audio of its own, so there is no meter — the
 * fader writes through setVcaGroupGain, and the mixer sync folds the offset into
 * every member track's lane gain. A member count hints at the group's reach.
 */

const props = defineProps<{
  /** The VCA group this strip controls. */
  group: VcaGroup;
}>();

const store = useProjectStore();
const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

const gainDb = computed(() => props.group.gainDb);
const muted = computed(() => props.group.mute === true);
const soloed = computed(() => props.group.solo === true);

/** Number of tracks currently assigned to this group. */
const memberCount = computed(
  () => store.tracks.filter((track) => track.vcaId === props.group.id).length,
);

function onFaderChange(db: number, commit: boolean): void {
  setVcaGroupGain(props.group.id, db, { commit });
}

function onRemove(): void {
  removeVcaGroup(props.group.id);
}

function onMute(): void {
  setVcaGroupMute(props.group.id, !muted.value);
}

function onSolo(): void {
  setVcaGroupSolo(props.group.id, !soloed.value);
}

function learnVcaId(param: MidiLearnVcaParam): string {
  return midiLearnVcaTargetId(props.group.id, param);
}

function learnVcaState(param: MidiLearnVcaParam): 'armed' | 'bound' | 'unbound' | undefined {
  if (!midiLearn) return undefined;
  const id = learnVcaId(param);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearnVca(param: MidiLearnVcaParam): void {
  midiLearn?.armId(learnVcaId(param));
}

function onMidiForgetVca(param: MidiLearnVcaParam): void {
  midiLearn?.clearId(learnVcaId(param));
}

async function onRename(): Promise<void> {
  const next = await promptDialog({
    title: t.value.shell.mixer.strip.renameVcaTitle,
    message: t.value.shell.mixer.strip.renameVcaMessage,
    defaultValue: props.group.name,
    placeholder: props.group.name,
    confirmLabel: t.value.shell.mixer.strip.renameVcaConfirm,
  });
  if (next && next !== props.group.name) renameVcaGroup(props.group.id, next);
}
</script>

<template>
  <div class="vca-strip">
    <div class="vca-header">
      <span class="vca-tag">{{ t.shell.mixer.strip.vca }}</span>
      <button
        type="button"
        class="vca-name"
        v-tooltip="t.shell.mixer.strip.renameVcaTitle"
        @click="onRename"
      >
        {{ props.group.name }}
      </button>
      <button
        type="button"
        class="vca-remove"
        v-tooltip="t.shell.mixer.strip.removeVcaTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.removeVca, { name: props.group.name })"
        @click="onRemove"
      >
        ×
      </button>
    </div>
    <div class="vca-buttons">
      <button
        type="button"
        class="vca-toggle"
        :class="{ 'vca-toggle-active': muted }"
        :aria-pressed="muted"
        :aria-label="
          muted ? t.shell.mixer.strip.unmute : formatMessage(t.shell.mixer.strip.muteNamed, { name: props.group.name })
        "
        v-tooltip="muted ? t.shell.mixer.strip.unmute : t.shell.mixer.strip.mute"
        @click="onMute"
      >
        M
      </button>
      <button
        v-if="learnVcaState('mute')"
        type="button"
        class="vca-midi-learn"
        :class="learnVcaState('mute')"
        v-tooltip="
          learnVcaState('mute') === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        "
        :aria-label="t.shell.mixer.controls.midiLearn"
        @click="onMidiLearnVca('mute')"
      >
        MIDI
      </button>
      <button
        v-if="learnVcaState('mute') === 'bound'"
        type="button"
        class="vca-midi-forget"
        v-tooltip="t.shell.mixer.controls.midiForget"
        :aria-label="t.shell.mixer.controls.midiForget"
        @click="onMidiForgetVca('mute')"
      >
        ×
      </button>
      <button
        type="button"
        class="vca-toggle"
        :class="{ 'vca-toggle-active': soloed }"
        :aria-pressed="soloed"
        :aria-label="
          soloed ? t.shell.mixer.strip.unsolo : formatMessage(t.shell.mixer.strip.soloNamed, { name: props.group.name })
        "
        v-tooltip="soloed ? t.shell.mixer.strip.unsolo : t.shell.mixer.strip.solo"
        @click="onSolo"
      >
        S
      </button>
      <button
        v-if="learnVcaState('solo')"
        type="button"
        class="vca-midi-learn"
        :class="learnVcaState('solo')"
        v-tooltip="
          learnVcaState('solo') === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        "
        :aria-label="t.shell.mixer.controls.midiLearn"
        @click="onMidiLearnVca('solo')"
      >
        MIDI
      </button>
      <button
        v-if="learnVcaState('solo') === 'bound'"
        type="button"
        class="vca-midi-forget"
        v-tooltip="t.shell.mixer.controls.midiForget"
        :aria-label="t.shell.mixer.controls.midiForget"
        @click="onMidiForgetVca('solo')"
      >
        ×
      </button>
    </div>
    <div class="vca-fader-row">
      <MixerFader :value-db="gainDb" :height="120" @change="onFaderChange" />
      <div v-if="learnVcaState('gain')" class="vca-fader-midi">
        <button
          type="button"
          class="vca-midi-learn"
          :class="learnVcaState('gain')"
          v-tooltip="
            learnVcaState('gain') === 'armed'
              ? t.shell.mixer.controls.midiLearnListening
              : t.shell.mixer.controls.midiLearn
          "
          :aria-label="t.shell.mixer.controls.midiLearn"
          @click="onMidiLearnVca('gain')"
        >
          MIDI
        </button>
        <button
          v-if="learnVcaState('gain') === 'bound'"
          type="button"
          class="vca-midi-forget"
          v-tooltip="t.shell.mixer.controls.midiForget"
          :aria-label="t.shell.mixer.controls.midiForget"
          @click="onMidiForgetVca('gain')"
        >
          ×
        </button>
      </div>
    </div>
    <NumericReadout
      class="vca-readout"
      :value="gainDb"
      :min="FADER_MIN_DB"
      :max="FADER_MAX_DB"
      :display="formatDb(gainDb)"
      unit="dB"
      :ariaLabel="t.shell.mixer.controls.stripGain"
      @change="(value) => onFaderChange(value, true)"
    />
    <span class="vca-members">
      {{ formatMessage(t.shell.mixer.strip.channelCount, { count: memberCount }) }}
    </span>
  </div>
</template>

<style scoped>
.vca-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  width: 72px;
  flex: none;
  box-sizing: border-box;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  border-right: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.vca-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}

.vca-tag {
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--surface-0);
  background: var(--warning);
  border-radius: var(--radius-sm);
  padding: 0 3px;
  flex: none;
}

.vca-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  text-align: left;
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  cursor: pointer;
}

.vca-name:hover {
  color: var(--text-1);
}

.vca-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: var(--fs-xs) var(--font-sans);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.vca-remove:hover {
  color: var(--danger-text);
}

.vca-buttons {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}

.vca-toggle {
  min-width: 0;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text-3);
  font: var(--fw-bold) var(--fs-2xs) var(--font-sans);
  line-height: 1;
  transition:
    background var(--dur-2) var(--ease-out),
    border-color var(--dur-2) var(--ease-out),
    color var(--dur-2) var(--ease-out),
    transform var(--dur-1) var(--ease-out);
}

.vca-toggle:active {
  transform: scale(0.94);
}

.vca-toggle-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text-1);
  --latch-from: 0.94;
  animation: toggle-latch var(--dur-3) var(--ease-spring);
}

.vca-midi-learn,
.vca-midi-forget {
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
.vca-midi-learn.armed {
  --live-color: var(--accent);
  color: var(--surface-0);
  background: var(--accent);
  animation: live-glow 1.8s var(--ease-out) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .vca-midi-learn.armed {
    animation: none;
  }
}

.vca-midi-learn.bound {
  color: var(--accent);
}

.vca-midi-forget {
  width: 14px;
  padding: 0;
  color: var(--text-4);
}

.vca-fader-row {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: var(--sp-1);
  flex: 1;
  min-height: 0;
}

.vca-fader-midi {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  align-items: center;
}

.vca-readout {
  font: var(--fw-medium) var(--fs-chrome-lg) var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.vca-members {
  font: var(--fw-medium) var(--fs-chrome-md) var(--font-sans);
  color: var(--text-4);
}
</style>

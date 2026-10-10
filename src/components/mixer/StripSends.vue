<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import { assertNoBusRoutingCycle, mixerBusTopology } from '@/project/bus-topology';
import {
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
  setSend,
} from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripSend } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import { midiLearnSendTargetId } from '@/ui/midi/midi-learn';
import { formatDb } from '@/ui/mixer/db-scale';
import MixerKnob from './MixerKnob.vue';
import NumericReadout from './NumericReadout.vue';

/**
 * Send section of a channel strip: one level knob per project bus, with a
 * per-send mute (click the bus name). Track and bus sends are live — strip-sync
 * mirrors them to the engine bus lanes — so they are audible; only the master
 * strip has no engine send bus, so its sends are routing-only. Bus-to-bus rows
 * stay visible for removing an old route, while self-routes and cycles are
 * disabled before they reach the command layer.
 */

const props = defineProps<{
  /** Strip the section edits: a track, group, return bus, or 'master'. */
  target: MixerStripTarget;
}>();

/** The master strip has no engine send bus, so its sends are routing-only. */
const isMaster = computed(() => props.target === 'master');
const sourceBusId = computed(() =>
  isMixerBusStripTarget(props.target) ? mixerBusIdFromTarget(props.target) : null,
);

const store = useProjectStore();
const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

/** Send level knob range in dB. */
const SEND_MIN_DB = -60;
const SEND_MAX_DB = 6;

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(props.target)) {
    const busId = mixerBusIdFromTarget(props.target);
    return store.mixer.buses.find((bus) => bus.id === busId)?.strip ?? createDefaultStrip();
  }
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const buses = computed(() => store.mixer.buses);

/** Local knob values while dragging (busId -> dB), cleared on commit. */
const preview = ref<Record<string, number>>({});

/**
 * Returns whether a return bus can receive another edge from this strip.
 * Ordinary tracks and groups have no user-visible bus node here, while return
 * buses participate in the project bus graph and must remain acyclic.
 */
function isSendDestinationAllowed(busId: string): boolean {
  const source = sourceBusId.value;
  if (source === null) return true;
  if (source === busId) return false;
  try {
    assertNoBusRoutingCycle(
      mixerBusTopology(
        store.mixer,
        store.tracks
          .filter((track) => track.kind === 'group')
          .map((track) => ({ id: track.id, mixer: track.mixer })),
      ),
      source,
      busId,
    );
    return true;
  } catch {
    return false;
  }
}

function sendFor(busId: string): StripSend | undefined {
  return strip.value.sends.find((send) => send.busId === busId);
}

function levelFor(busId: string): number {
  const dragged = preview.value[busId];
  if (dragged !== undefined) return dragged;
  return sendFor(busId)?.levelDb ?? SEND_MIN_DB;
}

function onLevelChange(busId: string, value: number, commit: boolean): void {
  if (!isSendDestinationAllowed(busId)) return;
  if (!commit) {
    preview.value = { ...preview.value, [busId]: value };
    return;
  }
  const { [busId]: _dropped, ...rest } = preview.value;
  preview.value = rest;
  const existing = sendFor(busId);
  if (!existing && value <= SEND_MIN_DB) return; // No send and knob at the floor: nothing to create.
  setSend(props.target, busId, { levelDb: value, enabled: existing?.enabled ?? true });
}

function onToggleEnabled(busId: string): void {
  if (!isSendDestinationAllowed(busId)) return;
  const existing = sendFor(busId);
  if (!existing) return;
  setSend(props.target, busId, { levelDb: existing.levelDb, enabled: !existing.enabled });
}

/** True when the send taps the source before the fader (default is post). */
function isPreFader(busId: string): boolean {
  return sendFor(busId)?.timing === 'preFader';
}

function onToggleTiming(busId: string): void {
  if (!isSendDestinationAllowed(busId)) return;
  const existing = sendFor(busId);
  if (!existing) return;
  setSend(props.target, busId, {
    levelDb: existing.levelDb,
    enabled: existing.enabled,
    timing: existing.timing === 'preFader' ? 'postFader' : 'preFader',
  });
}

function onRemove(busId: string): void {
  if (!sendFor(busId)) return;
  setSend(props.target, busId, null);
}

function learnTargetId(busId: string, param: 'level' | 'enabled' | 'timing' = 'level'): string {
  return typeof props.target === 'number' ? midiLearnSendTargetId(props.target, busId, param) : '';
}

function learnState(
  busId: string,
  param: 'level' | 'enabled' | 'timing' = 'level',
): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn) return undefined;
  const id = learnTargetId(busId, param);
  if (id === '') return undefined;
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearn(busId: string, param: 'level' | 'enabled' | 'timing' = 'level'): void {
  const id = learnTargetId(busId, param);
  if (id !== '') midiLearn?.armId(id);
}

function onMidiForget(busId: string, param: 'level' | 'enabled' | 'timing' = 'level'): void {
  const id = learnTargetId(busId, param);
  if (id !== '') midiLearn?.clearId(id);
}
</script>

<template>
  <div
    v-if="buses.length > 0"
    class="sends"
    v-tooltip="isMaster ? t.shell.mixer.sends.masterTitle : t.shell.mixer.sends.stripTitle"
  >
    <span class="sends-title">
      {{ t.shell.mixer.sends.title }}
      <span v-if="isMaster" class="sends-note"> · {{ t.shell.mixer.sends.routingOnly }}</span>
    </span>
    <TransitionGroup tag="div" name="list-row" class="send-rows">
    <div v-for="bus in buses" :key="bus.id" class="send-row">
      <button
        type="button"
        class="send-name"
        :class="{
          off: sendFor(bus.id)?.enabled === false,
          unset: !sendFor(bus.id),
          blocked: !isSendDestinationAllowed(bus.id),
        }"
        v-tooltip="
          !isSendDestinationAllowed(bus.id)
            ? t.shell.mixer.sends.blockedTitle
            : sendFor(bus.id)
            ? sendFor(bus.id)?.enabled === false
              ? t.shell.mixer.sends.mutedTitle
              : t.shell.mixer.sends.activeTitle
            : t.shell.mixer.sends.unsetTitle
        "
        @click="onToggleEnabled(bus.id)"
      >
        {{ bus.name }}
      </button>
      <button
        v-if="learnState(bus.id, 'enabled')"
        type="button"
        class="send-midi-learn"
        :class="learnState(bus.id, 'enabled')"
        v-tooltip="
          learnState(bus.id, 'enabled') === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        "
        :aria-label="t.shell.mixer.controls.midiLearn"
        @click="onMidiLearn(bus.id, 'enabled')"
      >
        MIDI
      </button>
      <button
        v-if="learnState(bus.id, 'enabled') === 'bound'"
        type="button"
        class="send-midi-forget"
        v-tooltip="t.shell.mixer.controls.midiForget"
        :aria-label="t.shell.mixer.controls.midiForget"
        @click="onMidiForget(bus.id, 'enabled')"
      >
        ×
      </button>
      <button
        v-if="!isMaster && sendFor(bus.id)"
        type="button"
        class="send-timing"
        :class="{ pre: isPreFader(bus.id) }"
        v-tooltip="
          isPreFader(bus.id) ? t.shell.mixer.sends.preFaderTitle : t.shell.mixer.sends.postFaderTitle
        "
        @click="onToggleTiming(bus.id)"
      >
        {{ isPreFader(bus.id) ? t.shell.mixer.sends.preFader : t.shell.mixer.sends.postFader }}
      </button>
      <button
        v-if="!isMaster && sendFor(bus.id) && learnState(bus.id, 'timing')"
        type="button"
        class="send-midi-learn"
        :class="learnState(bus.id, 'timing')"
        v-tooltip="
          learnState(bus.id, 'timing') === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        "
        :aria-label="t.shell.mixer.controls.midiLearn"
        @click="onMidiLearn(bus.id, 'timing')"
      >
        MIDI
      </button>
      <button
        v-if="!isMaster && sendFor(bus.id) && learnState(bus.id, 'timing') === 'bound'"
        type="button"
        class="send-midi-forget"
        v-tooltip="t.shell.mixer.controls.midiForget"
        :aria-label="t.shell.mixer.controls.midiForget"
        @click="onMidiForget(bus.id, 'timing')"
      >
        ×
      </button>
      <MixerKnob
        :value="levelFor(bus.id)"
        :min="SEND_MIN_DB"
        :max="SEND_MAX_DB"
        :display="`${formatDb(levelFor(bus.id))} dB`"
        :size="18"
        :disabled="!isSendDestinationAllowed(bus.id)"
        :midi-learn-state="learnState(bus.id)"
        @change="(value, commit) => onLevelChange(bus.id, value, commit)"
        @midi-learn="onMidiLearn(bus.id)"
        @midi-forget="onMidiForget(bus.id)"
      />
      <NumericReadout
        class="send-readout"
        :value="levelFor(bus.id)"
        :min="SEND_MIN_DB"
        :max="SEND_MAX_DB"
        :display="formatDb(levelFor(bus.id))"
        unit="dB"
        :ariaLabel="`${bus.name} ${t.shell.mixer.sends.title}`"
        :disabled="!isSendDestinationAllowed(bus.id)"
        @change="(value) => onLevelChange(bus.id, value, true)"
      />
      <button
        v-if="sendFor(bus.id)"
        type="button"
        class="send-remove"
        v-tooltip="t.shell.mixer.sends.remove"
        @click="onRemove(bus.id)"
      >
        ×
      </button>
      <span v-else class="send-remove-spacer" />
    </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.sends {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sends-title {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
  user-select: none;
}

.sends-note {
  font-weight: var(--fw-normal);
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-4);
}

.send-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.send-latency-warning {
  color: var(--warning, #fbbf24);
  font-size: var(--fs-2xs);
  line-height: 1;
}

.send-row {
  display: flex;
  align-items: center;
  gap: 3px;
}

.send-readout {
  width: 2.8rem;
  flex: none;
  text-align: right;
  font: var(--fs-2xs) var(--font-mono);
  color: var(--text-3);
}

.send-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--dur-2) var(--ease-out);
}

.send-name.off {
  text-decoration: line-through;
  color: var(--text-4);
}

.send-name.unset {
  color: var(--text-4);
}

.send-name.blocked {
  color: var(--text-4);
  cursor: not-allowed;
  text-decoration: line-through;
}

.send-timing {
  flex: none;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-4);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 3px;
  line-height: 1.4;
  cursor: pointer;
  transition:
    color var(--dur-2) var(--ease-out),
    border-color var(--dur-2) var(--ease-out);
}

.send-timing.pre {
  color: var(--accent);
  border-color: var(--accent-muted);
}

.send-midi-learn,
.send-midi-forget {
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
.send-midi-learn.armed {
  --live-color: var(--accent);
  color: var(--surface-0);
  background: var(--accent);
  animation: live-glow 1.8s var(--ease-out) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .send-midi-learn.armed {
    animation: none;
  }
}

.send-midi-learn.bound {
  color: var(--accent);
}

.send-midi-forget {
  width: 14px;
  padding: 0;
  color: var(--text-4);
}

.send-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: var(--fs-2xs) var(--font-sans);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.send-remove:hover {
  color: var(--danger-text);
}

.send-remove-spacer {
  width: 8px;
  flex: none;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MixerStripTarget } from '@/project/commands';
import { setSend } from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripSend } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatDb } from '@/ui/mixer/db-scale';
import MixerKnob from './MixerKnob.vue';

/**
 * Send section of a channel strip: one level knob per project bus, with a
 * per-send mute (click the bus name). Track sends are live — strip-sync mirrors
 * them to the engine bus lanes — so they are audible; only the master strip has
 * no engine send bus, so its sends are routing-only. setSend has no gesture
 * coalescing, so knob drags preview locally and issue a single command on
 * release — one undo entry per drag either way.
 */

const props = defineProps<{
  /** Strip the section edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

/** The master strip has no engine send bus, so its sends are routing-only. */
const isMaster = computed(() => props.target === 'master');

const store = useProjectStore();

/** Send level knob range in dB. */
const SEND_MIN_DB = -60;
const SEND_MAX_DB = 6;

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const buses = computed(() => store.mixer.buses);

/** Local knob values while dragging (busId -> dB), cleared on commit. */
const preview = ref<Record<string, number>>({});

function sendFor(busId: string): StripSend | undefined {
  return strip.value.sends.find((send) => send.busId === busId);
}

function levelFor(busId: string): number {
  const dragged = preview.value[busId];
  if (dragged !== undefined) return dragged;
  return sendFor(busId)?.levelDb ?? SEND_MIN_DB;
}

function onLevelChange(busId: string, value: number, commit: boolean): void {
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
  const existing = sendFor(busId);
  if (!existing) return;
  setSend(props.target, busId, { levelDb: existing.levelDb, enabled: !existing.enabled });
}

function onRemove(busId: string): void {
  if (!sendFor(busId)) return;
  setSend(props.target, busId, null);
}
</script>

<template>
  <div
    v-if="buses.length > 0"
    class="sends"
    :title="
      isMaster
        ? 'Master sends are routing-only (the master has no engine send bus)'
        : 'Send levels to the project buses — click a name to mute that send'
    "
  >
    <span class="sends-title">SENDS<span v-if="isMaster" class="sends-note"> · routing-only</span></span>
    <div v-for="bus in buses" :key="bus.id" class="send-row">
      <button
        type="button"
        class="send-name"
        :class="{ off: sendFor(bus.id)?.enabled === false, unset: !sendFor(bus.id) }"
        :title="
          sendFor(bus.id)
            ? sendFor(bus.id)?.enabled === false
              ? 'Muted send — click to unmute'
              : 'Active send — click to mute'
            : 'No send yet — turn the knob'
        "
        @click="onToggleEnabled(bus.id)"
      >
        {{ bus.name }}
      </button>
      <MixerKnob
        :value="levelFor(bus.id)"
        :min="SEND_MIN_DB"
        :max="SEND_MAX_DB"
        :display="`${formatDb(levelFor(bus.id))} dB`"
        :size="18"
        @change="(value, commit) => onLevelChange(bus.id, value, commit)"
      />
      <button
        v-if="sendFor(bus.id)"
        type="button"
        class="send-remove"
        title="Remove send"
        @click="onRemove(bus.id)"
      >
        ×
      </button>
      <span v-else class="send-remove-spacer" />
    </div>
  </div>
</template>

<style scoped>
.sends {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sends-title {
  font: var(--fw-bold) 8px var(--font-sans);
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

.send-row {
  display: flex;
  align-items: center;
  gap: 3px;
}

.send-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: 9px var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
}

.send-name.off {
  text-decoration: line-through;
  color: var(--text-4);
}

.send-name.unset {
  color: var(--text-4);
}

.send-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: 10px var(--font-sans);
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

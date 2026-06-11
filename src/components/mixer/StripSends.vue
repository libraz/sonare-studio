<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MixerStripTarget } from '@/project/commands';
import { setSend } from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripSend } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatDb } from '@/ui/mixer/db-scale';
import MixerKnob from './MixerKnob.vue';

/**
 * Send section of a channel strip: one level knob per project bus. Sends are
 * routing metadata only in this iteration (the engine has no bus routing for
 * prerendered clips), so the section is labelled accordingly. setSend has no
 * gesture coalescing, so knob drags preview locally and issue a single
 * command on release — one undo entry per drag either way.
 */

const props = defineProps<{
  /** Strip the section edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

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
  <div v-if="buses.length > 0" class="sends" title="Sends are routing metadata only (not audible yet)">
    <span class="sends-title">SENDS</span>
    <div v-for="bus in buses" :key="bus.id" class="send-row">
      <button
        type="button"
        class="send-name"
        :class="{ off: sendFor(bus.id)?.enabled === false, unset: !sendFor(bus.id) }"
        :title="sendFor(bus.id) ? 'Toggle send' : 'No send yet - turn the knob'"
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
  font: 700 8px system-ui, sans-serif;
  letter-spacing: 0.06em;
  color: #5b6270;
  user-select: none;
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
  font: 9px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}

.send-name.off {
  text-decoration: line-through;
  color: #5b6270;
}

.send-name.unset {
  color: #4a5160;
}

.send-remove {
  flex: none;
  border: none;
  background: transparent;
  color: #5b6270;
  font: 10px system-ui, sans-serif;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.send-remove:hover {
  color: #ffb4b4;
}

.send-remove-spacer {
  width: 8px;
  flex: none;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { MAX_TRACK_LANES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';

const emit = defineEmits<{
  add: [kind: 'midi' | 'audio' | 'group'];
}>();

const open = ref(false);
const menu = ref<HTMLDivElement | null>(null);
const { t } = useI18n();
const store = useProjectStore();
const limitBlocked = computed(() =>
  firstBlock([
    store.tracks.length >= MAX_TRACK_LANES,
    formatMessage(t.value.reasons.trackLimit, { limit: MAX_TRACK_LANES }),
  ]),
);

function onAdd(kind: 'midi' | 'audio' | 'group'): void {
  open.value = false;
  emit('add', kind);
}

useOutsidePointerDown(
  open,
  (target) => !!menu.value?.contains(target),
  () => {
    open.value = false;
  },
);
</script>

<template>
  <div ref="menu" class="add-track-menu">
    <button
      type="button"
      class="add-track"
      v-tooltip="{ text: t.shell.arrangement.addTrack.title, reason: limitBlocked }"
      :disabled="!!limitBlocked"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      {{ t.shell.arrangement.addTrack.trigger }} ▾
    </button>
    <Transition name="pop">
      <div v-if="open" class="add-track-items" role="menu">
        <button type="button" role="menuitem" @click="onAdd('midi')">
          {{ t.shell.arrangement.addTrack.midi }}
        </button>
        <button type="button" role="menuitem" @click="onAdd('audio')">
          {{ t.shell.arrangement.addTrack.audio }}
        </button>
        <button type="button" role="menuitem" @click="onAdd('group')">
          {{ t.shell.arrangement.addTrack.group }}
        </button>
      </div>
    </Transition>
  </div>
</template>

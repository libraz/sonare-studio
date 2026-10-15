<script setup lang="ts">
import { ref } from 'vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { useI18n } from '@/ui/i18n';

const emit = defineEmits<{
  add: [kind: 'midi' | 'audio' | 'group'];
}>();

const open = ref(false);
const menu = ref<HTMLDivElement | null>(null);
const { t } = useI18n();

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
      v-tooltip="t.shell.arrangement.addTrack.title"
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

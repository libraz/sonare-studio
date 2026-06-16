<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

const emit = defineEmits<{
  add: [kind: 'midi' | 'audio' | 'group'];
}>();

const open = ref(false);
const menu = ref<HTMLDivElement | null>(null);

function onAdd(kind: 'midi' | 'audio' | 'group'): void {
  open.value = false;
  emit('add', kind);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target)) {
    open.value = false;
  }
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
</script>

<template>
  <div ref="menu" class="add-track-menu">
    <button
      type="button"
      class="add-track"
      title="Add a track"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      + Track ▾
    </button>
    <div v-if="open" class="add-track-items" role="menu">
      <button type="button" role="menuitem" @click="onAdd('midi')">+ MIDI track</button>
      <button type="button" role="menuitem" @click="onAdd('audio')">+ Audio track</button>
      <button type="button" role="menuitem" @click="onAdd('group')">+ Group track</button>
    </div>
  </div>
</template>

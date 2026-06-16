<script setup lang="ts">
import type { EngineHandle } from '@/engine/engine';

defineProps<{
  busy: boolean;
  ctxState: string;
  handle: EngineHandle | null;
  renderInfo: string;
}>();

const emit = defineEmits<{
  renderOffline: [];
  testTone: [];
}>();
</script>

<template>
  <details class="diagnostics">
    <summary>Diagnostics</summary>
    <div class="diag-actions">
      <button type="button" :disabled="busy || !handle" @click="emit('testTone')">
        Test tone (1 s, bypasses engine)
      </button>
      <button type="button" :disabled="busy || !handle" @click="emit('renderOffline')">
        Render offline (3 s)
      </button>
    </div>
    <p v-if="renderInfo">{{ renderInfo }}</p>
    <p class="diag-shortcuts">
      Shortcuts: press ? for the full cheatsheet. Keys are remappable in Settings (⚙) → Shortcuts.
    </p>
    <ul v-if="handle">
      <li>mode: <strong>{{ handle.capabilities.mode }}</strong></li>
      <li>runtimeTarget: <strong>{{ handle.capabilities.runtimeTarget }}</strong></li>
      <li>abiCompatible: <strong>{{ handle.capabilities.abiCompatible ?? 'unknown' }}</strong></li>
      <li v-if="handle.capabilities.degradedReason">
        degradedReason: <strong>{{ handle.capabilities.degradedReason }}</strong>
      </li>
      <li>ctx.state: <strong>{{ ctxState }}</strong></li>
      <li>ctx.sampleRate: <strong>{{ handle.ctx.sampleRate }}</strong> Hz</li>
      <li>destination channels: <strong>{{ handle.ctx.destination.maxChannelCount }}</strong></li>
    </ul>
  </details>
</template>

<style scoped src="@/ui/shell/diagnostics-panel.css"></style>

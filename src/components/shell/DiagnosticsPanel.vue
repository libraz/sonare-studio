<script setup lang="ts">
import type { EngineHandle } from '@/engine/engine';
import { useI18n } from '@/ui/i18n';

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

const { t } = useI18n();
</script>

<template>
  <details class="diagnostics">
    <summary>{{ t.shell.diagnostics.title }}</summary>
    <div class="diag-actions">
      <button type="button" :disabled="busy || !handle" @click="emit('testTone')">
        {{ t.shell.diagnostics.testTone }}
      </button>
      <button type="button" :disabled="busy || !handle" @click="emit('renderOffline')">
        {{ t.shell.diagnostics.renderOffline }}
      </button>
    </div>
    <p v-if="renderInfo">{{ renderInfo }}</p>
    <p class="diag-shortcuts">{{ t.shell.diagnostics.shortcuts }}</p>
    <ul v-if="handle">
      <li>mode: <strong>{{ handle.capabilities.mode }}</strong></li>
      <li>runtimeTarget: <strong>{{ handle.capabilities.runtimeTarget }}</strong></li>
      <li>
        abiCompatible:
        <strong>{{ handle.capabilities.abiCompatible ?? t.shell.diagnostics.unknown }}</strong>
      </li>
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

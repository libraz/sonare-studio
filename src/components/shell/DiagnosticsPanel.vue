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
    <dl v-if="handle" class="diag-facts">
      <div class="diag-row">
        <dt>mode</dt>
        <dd><strong>{{ handle.capabilities.mode }}</strong></dd>
      </div>
      <div class="diag-row">
        <dt>runtimeTarget</dt>
        <dd><strong>{{ handle.capabilities.runtimeTarget }}</strong></dd>
      </div>
      <div class="diag-row">
        <dt>abiCompatible</dt>
        <dd>
          <strong>{{ handle.capabilities.abiCompatible ?? t.shell.diagnostics.unknown }}</strong>
        </dd>
      </div>
      <div v-if="handle.capabilities.degradedReason" class="diag-row">
        <dt>degradedReason</dt>
        <dd><strong>{{ handle.capabilities.degradedReason }}</strong></dd>
      </div>
      <div class="diag-row">
        <dt>ctx.state</dt>
        <dd><strong>{{ ctxState }}</strong></dd>
      </div>
      <div class="diag-row">
        <dt>ctx.sampleRate</dt>
        <dd><strong>{{ handle.ctx.sampleRate }}</strong> Hz</dd>
      </div>
      <div class="diag-row">
        <dt>destination channels</dt>
        <dd><strong>{{ handle.ctx.destination.maxChannelCount }}</strong></dd>
      </div>
    </dl>
  </details>
</template>

<style scoped src="@/ui/shell/diagnostics-panel.css"></style>

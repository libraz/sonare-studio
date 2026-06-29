<script setup lang="ts">
import { computed } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import type { EngineHandle } from '@/engine/engine';
import { useI18n } from '@/ui/i18n';

/**
 * Diagnostics dialog — a human-readable audio-engine health report opened from
 * the Help menu. It always presents a status summary (running / stopped) and,
 * once the engine is live, the audio-output facts (sample rate, latency,
 * channels), the negotiated runtime (transport mode, target, shared-memory
 * support) and ABI compatibility, so a user troubleshooting silent or degraded
 * playback gets actionable information rather than raw capability flags. The
 * test-tone and offline-render actions verify the signal path end to end.
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** True while a render / test-tone action is in flight. */
  busy: boolean;
  /** AudioContext lifecycle state, mirrored live (empty until the engine boots). */
  ctxState: string;
  /** The live engine handle, or null when the engine has not started yet. */
  handle: EngineHandle | null;
  /** Last offline-render result line, or empty before any render. */
  renderInfo: string;
}>();

const emit = defineEmits<{
  /** The user dismissed the dialog. */
  close: [];
  /** Run a 3-second offline render to verify the render path. */
  renderOffline: [];
  /** Play a 1-second test tone straight to the destination. */
  testTone: [];
}>();

const { t } = useI18n();

/** Output latency in milliseconds, or null when the context exposes none. */
const latencyMs = computed<number | null>(() => {
  const ctx = props.handle?.ctx;
  if (!ctx) return null;
  const seconds = ctx.outputLatency || ctx.baseLatency;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10000) / 10 : null;
});

/** Whether the engine reports a usable ABI (defaults to true when unspecified). */
const abiOk = computed(() => props.handle?.capabilities.abiCompatible ?? true);
</script>

<template>
  <AppModal
    :open="open"
    size="sm"
    :aria-label="t.shell.diagnostics.ariaLabel"
    @close="emit('close')"
  >
    <template #title>{{ t.shell.diagnostics.title }}</template>

    <div class="diag">
      <section class="diag-section">
        <h3 class="diag-heading">{{ t.shell.diagnostics.statusHeading }}</h3>
        <p class="diag-status" :class="handle ? 'diag-status-on' : 'diag-status-off'">
          <span class="diag-dot" aria-hidden="true" />
          {{ handle ? t.shell.diagnostics.running : t.shell.diagnostics.stopped }}
        </p>
        <p v-if="!handle" class="diag-hint">{{ t.shell.diagnostics.stoppedHint }}</p>
      </section>

      <template v-if="handle">
        <section class="diag-section">
          <h3 class="diag-heading">{{ t.shell.diagnostics.outputHeading }}</h3>
          <dl class="diag-facts">
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.sampleRate }}</dt>
              <dd><strong>{{ handle.ctx.sampleRate }}</strong> Hz</dd>
            </div>
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.latency }}</dt>
              <dd>
                <strong>{{ latencyMs ?? t.shell.diagnostics.unknown }}</strong>
                <template v-if="latencyMs"> ms</template>
              </dd>
            </div>
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.channels }}</dt>
              <dd><strong>{{ handle.ctx.destination.maxChannelCount }}</strong></dd>
            </div>
          </dl>
        </section>

        <section class="diag-section">
          <h3 class="diag-heading">{{ t.shell.diagnostics.runtimeHeading }}</h3>
          <dl class="diag-facts">
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.transportMode }}</dt>
              <dd><strong>{{ handle.capabilities.mode }}</strong></dd>
            </div>
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.runtimeTarget }}</dt>
              <dd><strong>{{ handle.capabilities.runtimeTarget }}</strong></dd>
            </div>
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.sharedMemory }}</dt>
              <dd>
                <strong>{{
                  handle.capabilities.sharedArrayBuffer && handle.capabilities.atomics
                    ? t.shell.diagnostics.available
                    : t.shell.diagnostics.unavailable
                }}</strong>
              </dd>
            </div>
            <div class="diag-row">
              <dt>{{ t.shell.diagnostics.abi }}</dt>
              <dd>
                <strong :class="abiOk ? 'diag-ok' : 'diag-bad'">
                  {{ abiOk ? t.shell.diagnostics.compatible : t.shell.diagnostics.incompatible }}
                </strong>
              </dd>
            </div>
            <div v-if="handle.capabilities.degradedReason" class="diag-row">
              <dd class="diag-warn">{{ handle.capabilities.degradedReason }}</dd>
            </div>
          </dl>
        </section>
      </template>

      <section class="diag-section">
        <h3 class="diag-heading">{{ t.shell.diagnostics.actionsHeading }}</h3>
        <div class="diag-actions">
          <button type="button" :disabled="busy || !handle" @click="emit('testTone')">
            {{ t.shell.diagnostics.testTone }}
          </button>
          <button type="button" :disabled="busy || !handle" @click="emit('renderOffline')">
            {{ t.shell.diagnostics.renderOffline }}
          </button>
        </div>
        <p v-if="renderInfo" class="diag-render-info">{{ renderInfo }}</p>
        <p class="diag-hint">{{ t.shell.diagnostics.shortcuts }}</p>
      </section>
    </div>

    <template #actions>
      <button type="button" class="primary" @click="emit('close')">
        {{ t.shell.diagnostics.close }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped src="@/ui/shell/diagnostics-panel.css"></style>

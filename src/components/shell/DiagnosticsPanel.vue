<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import type { EngineHandle } from '@/engine/engine';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { formatSize } from '@/ui/shell/format';

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

const actionBlocked = computed(() =>
  firstBlock([!props.handle, t.value.reasons.engineOff], [props.busy, t.value.reasons.busy]),
);

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
};

type NavigatorWithDeviceMemory = Navigator & {
  deviceMemory?: number;
};

const storageEstimate = ref<StorageEstimate | null>(null);

/** Output latency in milliseconds, or null when the context exposes none. */
const latencyMs = computed<number | null>(() => {
  const ctx = props.handle?.ctx;
  if (!ctx) return null;
  const seconds = ctx.outputLatency || ctx.baseLatency;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10000) / 10 : null;
});

/** Whether the engine reports a usable ABI (defaults to true when unspecified). */
const abiOk = computed(() => props.handle?.capabilities.abiCompatible ?? true);

const memory = computed(() => (globalThis.performance as PerformanceWithMemory).memory ?? null);

const usedHeap = computed(() =>
  memory.value?.usedJSHeapSize !== undefined ? formatSize(memory.value.usedJSHeapSize) : null,
);

const heapLimit = computed(() =>
  memory.value?.jsHeapSizeLimit !== undefined ? formatSize(memory.value.jsHeapSizeLimit) : null,
);

const storageUsage = computed(() =>
  storageEstimate.value?.usage !== undefined ? formatSize(storageEstimate.value.usage) : null,
);

const storageQuota = computed(() =>
  storageEstimate.value?.quota !== undefined ? formatSize(storageEstimate.value.quota) : null,
);

const hardwareConcurrency = computed(() => navigator.hardwareConcurrency || null);

const deviceMemory = computed(() => (navigator as NavigatorWithDeviceMemory).deviceMemory ?? null);

const isolated = computed(() => globalThis.crossOriginIsolated === true);

watch(
  () => props.open,
  async (open) => {
    if (!open || typeof navigator.storage?.estimate !== 'function') return;
    try {
      storageEstimate.value = await navigator.storage.estimate();
    } catch {
      storageEstimate.value = null;
    }
  },
  { immediate: true },
);
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
        <h3 class="diag-heading">{{ t.shell.diagnostics.performanceHeading }}</h3>
        <dl class="diag-facts">
          <div class="diag-row">
            <dt>{{ t.shell.diagnostics.cpuCores }}</dt>
            <dd>
              <strong>{{ hardwareConcurrency ?? t.shell.diagnostics.unknown }}</strong>
            </dd>
          </div>
          <div class="diag-row">
            <dt>{{ t.shell.diagnostics.deviceMemory }}</dt>
            <dd>
              <strong>{{ deviceMemory ?? t.shell.diagnostics.unknown }}</strong>
              <template v-if="deviceMemory"> GB</template>
            </dd>
          </div>
          <div class="diag-row">
            <dt>{{ t.shell.diagnostics.jsHeap }}</dt>
            <dd>
              <strong>{{ usedHeap ?? t.shell.diagnostics.unknown }}</strong>
              <template v-if="heapLimit"> / {{ heapLimit }}</template>
            </dd>
          </div>
          <div class="diag-row">
            <dt>{{ t.shell.diagnostics.storageEstimate }}</dt>
            <dd>
              <strong>{{ storageUsage ?? t.shell.diagnostics.unknown }}</strong>
              <template v-if="storageQuota"> / {{ storageQuota }}</template>
            </dd>
          </div>
          <div class="diag-row">
            <dt>{{ t.shell.diagnostics.crossOriginIsolated }}</dt>
            <dd>
              <strong>{{ isolated ? t.shell.diagnostics.available : t.shell.diagnostics.unavailable }}</strong>
            </dd>
          </div>
        </dl>
      </section>

      <section class="diag-section">
        <h3 class="diag-heading">{{ t.shell.diagnostics.actionsHeading }}</h3>
        <div class="diag-actions">
          <button
            type="button"
            :disabled="!!actionBlocked"
            v-tooltip="{ reason: actionBlocked }"
            @click="emit('testTone')"
          >
            {{ t.shell.diagnostics.testTone }}
          </button>
          <button
            type="button"
            :disabled="!!actionBlocked"
            v-tooltip="{ reason: actionBlocked }"
            @click="emit('renderOffline')"
          >
            {{ t.shell.diagnostics.renderOffline }}
          </button>
        </div>
        <p v-if="renderInfo" class="diag-render-info view-enter">{{ renderInfo }}</p>
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

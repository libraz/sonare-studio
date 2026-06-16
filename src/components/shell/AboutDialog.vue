<script setup lang="ts">
import AppModal from '@/components/shell/AppModal.vue';

/**
 * About dialog — the app's identity and runtime build/environment facts
 * (audio-engine version, cross-origin isolation) that used to clutter the
 * transport bar and the Diagnostics disclosure. Read-only.
 */

defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** libsonare audio-engine version string, or a placeholder while loading. */
  version: string;
  /** Whether the page is cross-origin isolated (SharedArrayBuffer available). */
  isolated: boolean;
}>();

const emit = defineEmits<{
  /** The user dismissed the dialog. */
  close: [];
}>();
</script>

<template>
  <AppModal :open="open" size="sm" aria-label="About sonare studio" @close="emit('close')">
    <template #title>About</template>

    <div class="about">
      <p class="about-brand">sonare studio</p>
      <p class="about-tagline">Browser-native DAW</p>

      <dl class="about-facts">
        <div class="about-row">
          <dt>Audio engine</dt>
          <dd>libsonare <strong>{{ version }}</strong></dd>
        </div>
        <div class="about-row">
          <dt>SharedArrayBuffer</dt>
          <dd>
            <strong>{{ isolated ? 'available' : 'unavailable' }}</strong>
            <span class="about-note">(crossOriginIsolated: {{ isolated }})</span>
          </dd>
        </div>
      </dl>
    </div>

    <template #actions>
      <button type="button" class="primary" @click="emit('close')">Close</button>
    </template>
  </AppModal>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.about-brand {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  letter-spacing: 0.02em;
  color: var(--text-1);
}

.about-tagline {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.about-facts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.about-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-4);
}

.about-row dt {
  color: var(--text-3);
}

.about-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.about-note {
  margin-left: var(--sp-2);
  color: var(--text-4);
  font-size: var(--fs-xs);
}
</style>

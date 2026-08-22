<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  applyPwaUpdateAndReload,
  dismissPwaUpdateNotice,
  type PwaUpdateReason,
  pwaUpdateFailure,
  pwaUpdateNotice,
} from '@/pwa';
import { useI18n } from '@/ui/i18n';

const NOTICE_KEY: Record<PwaUpdateReason, 'available' | 'engineVersion' | 'missingAsset'> = {
  update: 'available',
  'engine-version': 'engineVersion',
  'missing-asset': 'missingAsset',
};

const { t } = useI18n();
const applying = ref(false);
const message = computed(() =>
  pwaUpdateNotice.value ? t.value.shell.pwaUpdate[NOTICE_KEY[pwaUpdateNotice.value]] : '',
);

async function reload(): Promise<void> {
  if (applying.value) return;
  applying.value = true;
  try {
    await applyPwaUpdateAndReload();
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <aside v-if="pwaUpdateNotice" class="pwa-update" role="status" aria-live="polite">
    <div class="pwa-update-message">
      <span>{{ message }}</span>
      <span v-if="pwaUpdateFailure" class="pwa-update-error" role="alert">
        {{ t.shell.pwaUpdate.autosaveFailed }}
      </span>
    </div>
    <button type="button" :disabled="applying" @click="reload">
      {{ applying ? t.shell.pwaUpdate.applying : t.shell.pwaUpdate.reload }}
    </button>
    <button
      type="button"
      class="pwa-update-dismiss"
      :aria-label="t.shell.pwaUpdate.later"
      @click="dismissPwaUpdateNotice"
    >
      {{ t.shell.pwaUpdate.later }}
    </button>
  </aside>
</template>

<style scoped>
.pwa-update {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: var(--sp-2) var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--accent-muted);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.pwa-update-message {
  flex: 1;
}

.pwa-update-error {
  display: block;
  margin-top: var(--sp-1);
  color: var(--danger);
}

.pwa-update button {
  flex: none;
}

.pwa-update-dismiss {
  background: transparent;
  color: var(--text-2);
}
</style>

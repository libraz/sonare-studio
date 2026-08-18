<script setup lang="ts">
import { computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import {
  activeMixerSnapshotSlot,
  type MixerSnapshotSlot,
  mixerSnapshotFilled,
  mixerSnapshotSlots,
  recallMixerSnapshot,
  saveMixerSnapshot,
} from '@/project/commands';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Mixer snapshot controls for the mixer toolbar: slots A-D that
 * each store the current audible mix and recall it later. The letter button
 * recalls (disabled until the slot is stored, highlighted when it is the
 * active slot); the adjacent store button captures the current mix. Recall is
 * undoable, so an A/B switch can be reverted.
 */

const { t } = useI18n();
const appSettings = useAppSettings();

const SLOTS = mixerSnapshotSlots();

const active = computed(() => activeMixerSnapshotSlot());
const filled = computed<Record<MixerSnapshotSlot, boolean>>(
  () =>
    Object.fromEntries(SLOTS.map((slot) => [slot, mixerSnapshotFilled(slot)])) as Record<
      MixerSnapshotSlot,
      boolean
    >,
);

function recallTitle(slot: MixerSnapshotSlot): string {
  const key = filled.value[slot]
    ? t.value.shell.mixer.snapshots.recall
    : t.value.shell.mixer.snapshots.empty;
  return formatMessage(key, { slot });
}

function storeTitle(slot: MixerSnapshotSlot): string {
  return formatMessage(t.value.shell.mixer.snapshots.store, { slot });
}

function storeSnapshot(slot: MixerSnapshotSlot): void {
  void (async () => {
    if (
      filled.value[slot] &&
      appSettings.settings.confirmDestructive &&
      !(await confirmDialog({
        title: t.value.shell.mixer.snapshots.overwriteTitle,
        message: formatMessage(t.value.shell.mixer.snapshots.overwriteMessage, { slot }),
        danger: true,
        confirmLabel: t.value.shell.mixer.snapshots.overwrite,
      }))
    )
      return;
    saveMixerSnapshot(slot);
  })();
}
</script>

<template>
  <div class="snapshots" role="group" :aria-label="t.shell.mixer.snapshots.region">
    <span class="snapshots-label">{{ t.shell.mixer.snapshots.label }}</span>
    <span v-for="slot in SLOTS" :key="slot" class="snapshot-slot">
      <button
        type="button"
        class="snapshot-recall"
        :class="{ active: active === slot, filled: filled[slot] }"
        :disabled="!filled[slot]"
        v-tooltip="recallTitle(slot)"
        :aria-label="recallTitle(slot)"
        @click="recallMixerSnapshot(slot)"
      >
        {{ slot }}
      </button>
      <button
        type="button"
        class="snapshot-store"
        v-tooltip="storeTitle(slot)"
        :aria-label="storeTitle(slot)"
        @click="storeSnapshot(slot)"
      >
        ⤓
      </button>
    </span>
  </div>
</template>

<style scoped>
.snapshots {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.snapshots-label {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
  user-select: none;
}

.snapshot-slot {
  display: inline-flex;
  align-items: center;
}

.snapshot-recall,
.snapshot-store {
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  background: var(--surface-3);
  padding: 2px var(--sp-2);
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition: background var(--dur-1) var(--ease-out);
}

.snapshot-recall {
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  min-width: 16px;
}

.snapshot-store {
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-4);
}

.snapshot-recall:hover:not(:disabled),
.snapshot-store:hover {
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.snapshot-recall:disabled {
  opacity: 0.45;
  cursor: default;
}

.snapshot-recall.filled {
  color: var(--text-1);
}

.snapshot-recall.active {
  color: var(--surface-0);
  background: var(--accent);
}
</style>

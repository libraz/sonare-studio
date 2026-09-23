<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatBarBeatTick } from '@/components/lists/bar-beat';
import AppModal from '@/components/shell/AppModal.vue';
import { type KeyChangeProposal, proposeKeyChanges } from '@/compose/key-changes';
import { buildKeyMap } from '@/compose/key-map';
import { buildVoiceLines } from '@/compose/voice-context';
import { applyKeyChangeMarkers } from '@/project/command/key-changes';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Detects key changes from the notes already on the timeline and lets the
 * user pick which ones become `Key:` markers.
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const g = computed(() => t.value.shell.generate.keyChange);

/** Proposals snapshotted on open, so `checked` stays index-aligned with them. */
const proposals = ref<KeyChangeProposal[]>([]);
const checked = ref<boolean[]>([]);
const error = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = null;
    // No track is excluded: the search wants every harmonic part, so an id no
    // track can have leaves the line set whole.
    const lines = buildVoiceLines(store.tracks, store.clipsByTrack, -1);
    const keyMap = buildKeyMap(store.scaleHighlight, store.markers);
    proposals.value = proposeKeyChanges(lines, store.timeSignatures, keyMap);
    checked.value = proposals.value.map((proposal) => proposal.selected);
  },
  { immediate: true },
);

const selectedCount = computed(() => checked.value.filter(Boolean).length);

function onCancel(): void {
  emit('close');
}

function onApply(): void {
  const selected = proposals.value.filter((_, index) => checked.value[index]);
  if (selected.length === 0) return;
  try {
    applyKeyChangeMarkers(selected);
    emit('close');
  } catch {
    error.value = g.value.error;
  }
}
</script>

<template>
  <AppModal :open="props.open" size="md" :aria-label="g.title" @close="onCancel">
    <template #title>{{ g.title }}</template>

    <div class="key-change-fields">
      <p class="key-change-description">{{ g.description }}</p>

      <p v-if="proposals.length === 0" class="key-change-empty">{{ g.empty }}</p>
      <div v-else class="key-change-list">
        <label
          v-for="(proposal, index) in proposals"
          :key="proposal.startPpq"
          class="key-change-row"
          :class="{ checked: checked[index] }"
        >
          <input v-model="checked[index]" type="checkbox" />
          <span class="key-change-label">
            {{
              formatMessage(g.itemLabel, {
                position: formatBarBeatTick(proposal.startPpq, store.timeSignatures),
                key: proposal.label,
              })
            }}
          </span>
        </label>
      </div>

      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <button type="button" @click="onCancel">{{ g.cancel }}</button>
      <button
        type="button"
        class="primary"
        :disabled="selectedCount === 0"
        @click="onApply"
      >
        {{ selectedCount > 0 ? formatMessage(g.apply, { count: selectedCount }) : g.applyEmpty }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.key-change-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 22rem;
}

.key-change-description {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.key-change-empty {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.key-change-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 16rem;
  overflow-y: auto;
}

/* Bordered row; checked rows carry the accent via full border + light tint,
 * never a one-sided stripe (see design-taste). */
.key-change-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  box-sizing: border-box;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.key-change-row.checked {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.key-change-label {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
}

.dialog-error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--fs-sm);
}
</style>

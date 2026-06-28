<script setup lang="ts">
import { ref } from 'vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { useI18n } from '@/ui/i18n';
import { humanizePresetName } from '@/ui/mastering/preset-catalog';

/**
 * Searchable mastering preset dropdown. Purely presentational: the menu's
 * open state, the lazily loaded catalog and the (undoable) preset apply are
 * owned by the panel; this component renders the trigger and the filtered
 * menu and emits the user's intent. Its root element is exposed so the panel
 * can keep the shared outside-click dismissal.
 */

defineProps<{
  /** Currently selected preset id, or undefined when none is set. */
  preset: string | undefined;
  /** Display label for the trigger button. */
  presetLabel: string;
  /** True when the dropdown is open. */
  menuOpen: boolean;
  /** Current search query. */
  query: string;
  /** Preset ids matching the query, in menu order. */
  filteredPresets: ReadonlyArray<string>;
}>();

const emit = defineEmits<{
  (event: 'toggle'): void;
  (event: 'update:query', value: string): void;
  (event: 'select', preset: string | null): void;
}>();

const { t } = useI18n();

const root = ref<HTMLDivElement | null>(null);

defineExpose({ root });
</script>

<template>
  <div ref="root" class="preset-wrap">
    <button
      type="button"
      class="preset-button"
      :class="{ set: preset !== undefined }"
      :title="t.shell.mastering.presetTitle"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="emit('toggle')"
    >
      <span class="preset-label">{{ presetLabel }}</span>
      <TransportIcon name="chevron-down" class="preset-caret" />
    </button>
    <div v-if="menuOpen" class="preset-menu" role="menu">
      <input
        :value="query"
        type="search"
        class="preset-search"
        :placeholder="t.shell.mastering.searchPresets"
        :aria-label="t.shell.mastering.searchPresets"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <button type="button" role="menuitem" class="preset-item none" @click="emit('select', null)">
        {{ t.shell.mastering.noPreset }}
      </button>
      <button
        v-for="item in filteredPresets"
        :key="item"
        type="button"
        role="menuitem"
        class="preset-item"
        :class="{ active: item === preset }"
        @click="emit('select', item)"
      >
        {{ humanizePresetName(item) }}
      </button>
      <p v-if="filteredPresets.length === 0" class="preset-empty">
        {{ t.shell.mastering.noMatches }}
      </p>
    </div>
  </div>
</template>

<style scoped src="./preset-selector.css"></style>

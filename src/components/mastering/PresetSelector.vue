<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { useI18n } from '@/ui/i18n';
import { humanizePresetName, isRestorationPreset } from '@/ui/mastering/preset-catalog';

/**
 * Searchable mastering preset dropdown. Purely presentational: the menu's
 * open state, the lazily loaded catalog and the (undoable) preset apply are
 * owned by the panel; this component renders the trigger and the filtered
 * menu and emits the user's intent. Its root element is exposed so the panel
 * can keep the shared outside-click dismissal.
 */

const props = defineProps<{
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

const masteringPresets = computed(() =>
  props.filteredPresets.filter((item) => !isRestorationPreset(item)),
);
const restorationPresets = computed(() => props.filteredPresets.filter(isRestorationPreset));

defineExpose({ root });
</script>

<template>
  <div ref="root" class="preset-wrap">
    <button
      type="button"
      class="preset-button"
      :class="{ set: preset !== undefined }"
      v-tooltip="t.shell.mastering.presetTitle"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="emit('toggle')"
    >
      <span class="preset-label">{{ presetLabel }}</span>
      <TransportIcon name="chevron-down" class="preset-caret" />
    </button>
    <Transition name="pop">
    <div v-if="menuOpen" class="preset-menu" role="menu">
      <SearchField
        :model-value="query"
        size="sm"
        class="preset-search"
        :placeholder="t.shell.mastering.searchPresets"
        :aria-label="t.shell.mastering.searchPresets"
        @update:model-value="emit('update:query', $event)"
      />
      <button type="button" role="menuitem" class="preset-item none" @click="emit('select', null)">
        {{ t.shell.mastering.noPreset }}
      </button>
      <button
        v-for="item in masteringPresets"
        :key="item"
        type="button"
        role="menuitem"
        class="preset-item"
        :class="{ active: item === preset }"
        @click="emit('select', item)"
      >
        {{ humanizePresetName(item) }}
      </button>
      <template v-if="restorationPresets.length > 0">
        <div class="preset-heading" role="presentation">
          {{ t.shell.mastering.restorationPresets }}
        </div>
        <button
          v-for="item in restorationPresets"
          :key="item"
          type="button"
          role="menuitem"
          class="preset-item"
          :class="{ active: item === preset }"
          v-tooltip="t.shell.mastering.restorationPresetsTitle"
          @click="emit('select', item)"
        >
          {{ humanizePresetName(item) }}
        </button>
      </template>
      <EmptyState
        v-if="filteredPresets.length === 0"
        variant="inline"
        :message="t.shell.mastering.noMatches"
      />
    </div>
    </Transition>
  </div>
</template>

<style scoped src="./preset-selector.css"></style>

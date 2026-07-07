<script setup lang="ts">
/**
 * Inline glyphs for the list-editor row affordances, replacing the platform
 * emoji codepoints (▶ / ✕) that rendered inconsistently across systems. Each
 * icon inherits `currentColor`, so it tracks the host row button's state
 * colours (hover, disabled) for free and stays crisp at small sizes.
 */
export type ListIconName = 'seek' | 'delete' | 'reharm';

defineProps<{ name: ListIconName }>();
</script>

<template>
  <svg
    class="list-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Seek: a right-pointing play triangle. -->
    <path v-if="name === 'seek'" d="M5 3.5 12 8 5 12.5 Z" fill="currentColor" />

    <!-- Delete: an X cross. -->
    <path
      v-else-if="name === 'delete'"
      d="M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />

    <!-- Reharmonize: two arrows swapping direction. -->
    <path
      v-else-if="name === 'reharm'"
      d="M3 5.5 H11 M9 3.5 11 5.5 9 7.5 M13 10.5 H5 M7 8.5 5 10.5 7 12.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.list-icon {
  display: block;
  width: 12px;
  height: 12px;
}
</style>

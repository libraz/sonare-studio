<script setup lang="ts">
/**
 * Crisp vector close (X) glyph, matching the modal's close affordance. Inherits
 * `currentColor` so it picks up the host button's state colours, replacing the
 * bare unicode glyphs that rendered inconsistently across platforms.
 */
</script>

<template>
  <svg class="close-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M4 4l8 8M12 4l-8 8"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </svg>
</template>

<style scoped>
.close-icon {
  display: block;
  width: 14px;
  height: 14px;
}
</style>

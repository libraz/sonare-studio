<script setup lang="ts">
/**
 * The elapsed-seconds readout. Reading the per-frame position here, not in the
 * transport bar, keeps playback ticks from re-rendering the whole bar.
 */
defineProps<{
  /** Current position in seconds; read during render so only this text tracks it. */
  readSeconds: () => number;
}>();
</script>

<template>
  <span>{{ readSeconds().toFixed(2) }}s</span>
</template>

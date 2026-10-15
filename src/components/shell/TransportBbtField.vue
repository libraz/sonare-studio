<script setup lang="ts">
/**
 * The bars.beats readout input. Reading the per-frame position here, not in
 * the transport bar, keeps playback ticks from re-rendering the whole bar.
 */
defineProps<{
  /** Current display text; read during render so only this field tracks it. */
  readValue: () => string;
}>();
</script>

<template>
  <input type="text" inputmode="numeric" spellcheck="false" :value="readValue()" />
</template>

<script setup lang="ts">
defineProps<{
  rowCount: number;
  rowHeight: number;
}>();
</script>

<template>
  <div class="track-takes" @click.stop>
    <div
      v-for="row in rowCount"
      :key="row"
      class="take-label-row"
      :style="{ height: `${rowHeight}px` }"
    >
      Take {{ row }}
    </div>
  </div>
</template>

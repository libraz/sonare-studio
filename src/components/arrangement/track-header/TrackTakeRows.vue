<script setup lang="ts">
const props = defineProps<{
  rowCount: number;
  rowHeight: number;
  /** 1-based index of the live/comped take row; -1 when none is unambiguous. */
  activeTake?: number;
}>();

/** True when `row` (1-based) is the track's live/comped take. */
function isActive(row: number): boolean {
  return (props.activeTake ?? -1) === row - 1;
}
</script>

<template>
  <div class="track-takes" @click.stop>
    <div
      v-for="row in rowCount"
      :key="row"
      class="take-label-row"
      :class="{ 'take-active': isActive(row) }"
      :style="{ height: `${rowHeight}px` }"
    >
      Take {{ row }}
    </div>
  </div>
</template>

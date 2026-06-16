<script setup lang="ts">
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { AutomationLaneState, AutomationParam } from '@/project/automation';
import type { EditorTrack } from '@/project/types';

defineProps<{
  track: EditorTrack;
  lane: AutomationLaneState | null;
  param: AutomationParam;
  options: ReadonlyArray<{ value: AutomationParam; label: string }>;
}>();

const emit = defineEmits<{
  paramChange: [track: EditorTrack, value: string];
  enabledChange: [track: EditorTrack, event: Event];
}>();
</script>

<template>
  <div class="track-automation" @click.stop>
    <span class="automation-label">AUTO</span>
    <SelectMenu
      class="automation-param"
      size="sm"
      :model-value="param"
      :options="options"
      :aria-label="`Automation parameter of ${track.name}`"
      @change="emit('paramChange', track, $event)"
    />
    <label
      class="automation-enable"
      :title="lane ? 'Apply during playback' : 'No automation points yet'"
    >
      <input
        type="checkbox"
        :checked="lane?.enabled ?? false"
        :disabled="lane === null"
        :aria-label="`Enable automation of ${track.name}`"
        @change="emit('enabledChange', track, $event)"
      />
      On
    </label>
  </div>
</template>

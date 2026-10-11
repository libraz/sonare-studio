<script setup lang="ts">
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import type { AutomationLaneState, AutomationParam } from '@/project/automation';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

defineProps<{
  track: EditorTrack;
  lane: AutomationLaneState | null;
  param: AutomationParam;
  options: ReadonlyArray<{ value: AutomationParam; label: string }>;
}>();

const emit = defineEmits<{
  paramChange: [track: EditorTrack, value: string];
  enabledChange: [track: EditorTrack, enabled: boolean];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="track-automation" @click.stop>
    <span class="automation-label">{{ t.shell.arrangement.automation.label }}</span>
    <SelectMenu
      class="automation-param"
      size="sm"
      :model-value="param"
      :options="options"
      :aria-label="formatMessage(t.shell.arrangement.automation.parameter, { name: track.name })"
      :title="t.shell.arrangement.automation.parameterTitle"
      @change="emit('paramChange', track, $event)"
    />
    <ToggleButton
      class="automation-enable"
      size="sm"
      :model-value="lane?.enabled ?? false"
      :reason="lane === null ? t.shell.arrangement.automation.noPoints : null"
      :label="t.shell.arrangement.automation.on"
      :aria-label="formatMessage(t.shell.arrangement.automation.enable, { name: track.name })"
      :title="t.shell.arrangement.automation.applyTitle"
      @update:model-value="emit('enabledChange', track, $event)"
    />
  </div>
</template>

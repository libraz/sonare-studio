import { computed, ref } from 'vue';
import { evaluateProjectCapacity, formatProjectCapacityIssue } from '@/project/project-capacity';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/**
 * Project-capacity warning derived purely from the project snapshot: the engine
 * addresses mixer strips and internal instruments through fixed-width id
 * spaces, so a project that outgrows them silently loses telemetry or misroutes
 * control. Dismiss hides the current set; a changed set re-surfaces.
 */
export function useProjectCapacityWarning() {
  const store = useProjectStore();
  const { t } = useI18n();
  const capacityIssues = computed(() =>
    evaluateProjectCapacity(store.tracks, store.projectExternalMidi),
  );
  const dismissedCapacityKey = ref('');
  const capacityWarning = computed(() => {
    const issues = capacityIssues.value;
    if (issues.length === 0) return '';
    const key = JSON.stringify(issues);
    if (key === dismissedCapacityKey.value) return '';
    const strings = t.value.shell.capacity;
    const lines = issues.map((issue) => formatProjectCapacityIssue(issue, strings));
    return [strings.warningIntro, ...lines].join('\n');
  });
  function dismissCapacityWarning(): void {
    dismissedCapacityKey.value = JSON.stringify(capacityIssues.value);
  }

  return { capacityWarning, dismissCapacityWarning };
}

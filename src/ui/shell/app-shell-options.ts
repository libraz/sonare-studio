import type { TourStep } from '@/components/onboarding/tour-steps';
import type { DockTab } from '@/composables/useAppShellLayout';
import { COUNT_IN_BARS_MAX, COUNT_IN_BARS_MIN } from '@/ui/settings/app-settings';

/** Count-in bar choices (Off through the maximum); the transport bar localizes the labels. */
export const COUNT_IN_CHOICES: readonly { value: number }[] = Array.from(
  { length: COUNT_IN_BARS_MAX - COUNT_IN_BARS_MIN + 1 },
  (_, index) => ({ value: COUNT_IN_BARS_MIN + index }),
);

const GRID_SNAP_CHOICES = [
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8 / 3, label: '1/4.' },
  { value: 8, label: '1/8' },
  { value: 12, label: '1/8T' },
  { value: 16 / 3, label: '1/8.' },
  { value: 16, label: '1/16' },
  { value: 24, label: '1/16T' },
  { value: 32 / 3, label: '1/16.' },
  { value: 32, label: '1/32' },
] as const;

/** Snap grid choices, led by the bar option under its localized label. */
export function snapChoices(barLabel: string) {
  return [{ value: 'bar' as const, label: barLabel }, ...GRID_SNAP_CHOICES];
}

/** Tour anchors in order; the localized title and body come from the i18n tree by id. */
export const TOUR_STEPS: Omit<TourStep, 'title' | 'body'>[] = [
  { id: 'transport', target: '.transport-bar', placement: 'top' },
  { id: 'arrange', target: '.arrange-zone' },
  { id: 'dock', target: '.dock-tabs', placement: 'top' },
  { id: 'roll', target: '.piano-roll-host', placement: 'top' },
  { id: 'score', target: '.dock-tab-score', placement: 'top' },
  { id: 'menu', target: '.app-menubar:not(.app-menubar--end)' },
];

/** Editor dock tabs in strip order; `labelKey` indexes the localized `tabs` / `tabTitles` trees. */
export const DOCK_TABS = [
  { id: 'roll', labelKey: 'pianoRoll' },
  { id: 'mixer', labelKey: 'mixer' },
  { id: 'mastering', labelKey: 'mastering' },
  { id: 'steps', labelKey: 'steps' },
  { id: 'lists', labelKey: 'lists' },
  { id: 'media', labelKey: 'media' },
  { id: 'sample', labelKey: 'sample' },
] as const satisfies readonly {
  id: DockTab;
  labelKey: 'pianoRoll' | 'mixer' | 'mastering' | 'steps' | 'lists' | 'media' | 'sample';
}[];

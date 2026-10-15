import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@/ui/i18n';
import { COUNT_IN_BARS_MAX, COUNT_IN_BARS_MIN } from '@/ui/settings/app-settings';
import { COUNT_IN_CHOICES, snapChoices, TOUR_STEPS } from '@/ui/shell/app-shell-options';

describe('snapChoices', () => {
  it('offers bar, triplet, and dotted grids alongside straight note divisions', () => {
    const SNAP_CHOICES = snapChoices('小節');
    expect(SNAP_CHOICES[0]).toEqual({ value: 'bar', label: '小節' });
    expect(SNAP_CHOICES).toContainEqual({ value: 12, label: '1/8T' });
    expect(SNAP_CHOICES).toContainEqual({ value: 24, label: '1/16T' });
    expect(SNAP_CHOICES).toContainEqual({ value: 8 / 3, label: '1/4.' });
    expect(SNAP_CHOICES).toContainEqual({ value: 16 / 3, label: '1/8.' });
    expect(SNAP_CHOICES).toContainEqual({ value: 32 / 3, label: '1/16.' });
  });
});

describe('COUNT_IN_CHOICES', () => {
  it('spans the count-in bar bounds', () => {
    expect(COUNT_IN_CHOICES[0].value).toBe(COUNT_IN_BARS_MIN);
    expect(COUNT_IN_CHOICES[COUNT_IN_CHOICES.length - 1].value).toBe(COUNT_IN_BARS_MAX);
  });
});

describe('TOUR_STEPS', () => {
  it('has localized copy for every step in both languages', () => {
    for (const language of ['en', 'ja'] as const) {
      const copy = MESSAGES[language].shell.tour.steps as Record<
        string,
        { title: string; body: string } | undefined
      >;
      for (const step of TOUR_STEPS) {
        expect(copy[step.id]?.title, `${language}:${step.id}`).toBeTruthy();
        expect(copy[step.id]?.body, `${language}:${step.id}`).toBeTruthy();
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { MODE_OPTIONS, scaleName } from '@/ui/sample-editor/scales';

describe('sample editor scale names by language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('labels the mode picker in Japanese', () => {
    expect(MODE_OPTIONS.value.map((option) => option.label)).toEqual([
      'メジャー',
      'マイナー',
      'ドリアン',
      'フリジアン',
      'リディアン',
      'ミクソリディアン',
      'ロクリアン',
    ]);
  });

  it('names a scale with the localized mode', () => {
    expect(scaleName(9, 1)).toBe('A マイナー');
    expect(scaleName(0, 99)).toBe('C メジャー');
  });

  it('follows a language switch', () => {
    settings.set('language', 'en');
    expect(MODE_OPTIONS.value[0]).toEqual({ value: '0', label: 'Major' });
    expect(scaleName(6, 4)).toBe('F# Lydian');
  });
});

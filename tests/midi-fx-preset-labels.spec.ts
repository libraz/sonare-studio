import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiFxPanel from '@/components/piano-roll/MidiFxPanel.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { MESSAGES } from '@/ui/i18n/messages';

vi.mock('@/project/commands', () => ({ bakeClipMidiFx: vi.fn() }));

const settings = useAppSettings();
const previous = settings.settings.language;
let wrapper: VueWrapper | null = null;

beforeEach(() => settings.set('language', 'ja'));
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  settings.set('language', previous);
});

/** Chip labels of the group whose aria-label is `groupLabel`. */
function chipLabels(w: VueWrapper, groupLabel: string): string[] {
  const group = w.find(`[role="group"][aria-label="${groupLabel}"]`);
  return group.findAll('button.fx-chip').map((b) => b.text());
}

describe('MIDI FX preset labels', () => {
  it('shows the harmonize and arpeggio presets in the UI language', () => {
    const m = MESSAGES.ja.shell.pianoRoll.midiTransform;
    wrapper = mount(MidiFxPanel, { props: { clipId: 1 } });

    expect(chipLabels(wrapper, m.harmonizeChord)).toEqual([
      'オフ',
      'オクターブ',
      '5 度',
      'メジャー',
      'マイナー',
      'Sus4',
      'Maj7',
      'Min7',
      'Dom7',
      'スプレッド',
    ]);
    expect(chipLabels(wrapper, m.arpPattern).slice(0, 7)).toEqual([
      'オフ',
      'オクターブ',
      'アップ',
      'アップ+8ve',
      'マイナー',
      'オクターブ重ね',
      'アップ/ダウン',
    ]);
  });

  it('follows the language when it changes', async () => {
    wrapper = mount(MidiFxPanel, { props: { clipId: 1 } });
    settings.set('language', 'en');
    await wrapper.vm.$nextTick();

    const m = MESSAGES.en.shell.pianoRoll.midiTransform;
    expect(chipLabels(wrapper, m.harmonizeChord)[3]).toBe('Major');
    expect(chipLabels(wrapper, m.arpPattern)[3]).toBe('Up+8ve');
  });
});

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';

describe('SelectMenu default placeholder', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('shows the localized placeholder when nothing is selected and none is passed', () => {
    const wrapper = mount(SelectMenu, {
      props: { modelValue: 'none', options: [{ value: 'a', label: 'A' }] },
    });
    expect(wrapper.find('.select-value').text()).toBe('選択…');
  });

  it('keeps a caller-supplied placeholder', () => {
    const wrapper = mount(SelectMenu, {
      props: { modelValue: 'none', options: [{ value: 'a', label: 'A' }], placeholder: 'Pick' },
    });
    expect(wrapper.find('.select-value').text()).toBe('Pick');
  });
});

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PwaUpdateBanner from '@/components/shell/PwaUpdateBanner.vue';
import {
  dismissPwaUpdateNotice,
  installPwaReloadPreparation,
  requestPwaEngineRecovery,
} from '@/pwa';

describe('PwaUpdateBanner', () => {
  beforeEach(() => dismissPwaUpdateNotice());

  it('surfaces engine-version recovery and lets the user defer it', async () => {
    requestPwaEngineRecovery();
    const wrapper = mount(PwaUpdateBanner);
    expect(wrapper.get('[role="status"]').text()).toContain('different versions');
    await wrapper.findAll('button')[1].trigger('click');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('shows a save failure and keeps its update action available as a retry', async () => {
    requestPwaEngineRecovery();
    const removePreparation = installPwaReloadPreparation(vi.fn(async () => false));
    const wrapper = mount(PwaUpdateBanner);

    await wrapper.findAll('button')[0].trigger('click');

    expect(wrapper.get('[role="alert"]').text()).toContain('could not be saved');
    expect(wrapper.findAll('button')[0].attributes('disabled')).toBeUndefined();
    removePreparation();
  });
});

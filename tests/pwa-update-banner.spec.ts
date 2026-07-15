import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import PwaUpdateBanner from '@/components/shell/PwaUpdateBanner.vue';
import { dismissPwaUpdateNotice, requestPwaEngineRecovery } from '@/pwa';

describe('PwaUpdateBanner', () => {
  beforeEach(() => dismissPwaUpdateNotice());

  it('surfaces engine-version recovery and lets the user defer it', async () => {
    requestPwaEngineRecovery();
    const wrapper = mount(PwaUpdateBanner);
    expect(wrapper.get('[role="status"]').text()).toContain('different versions');
    await wrapper.findAll('button')[1].trigger('click');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});

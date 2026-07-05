import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import HintCard from '@/components/onboarding/HintCard.vue';
import type { TourStep } from '@/components/onboarding/tour-steps';
import WelcomeTour from '@/components/onboarding/WelcomeTour.vue';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
} from '@/ui/overlay-registry';

const STORAGE_KEY = 'sonare-studio.test.tourSeen';

const STEPS: TourStep[] = [
  { id: 'one', target: '#anchor-one', title: 'Step one', body: 'First stop.' },
  { id: 'two', target: '#anchor-two', title: 'Step two', body: 'Second stop.' },
  { id: 'gone', target: '#anchor-missing', title: 'Hidden', body: 'Never shown.' },
];

/** Mounts the tour attached to the document so querySelector finds anchors. */
function mountTour(props: Partial<InstanceType<typeof WelcomeTour>['$props']> = {}) {
  return mount(WelcomeTour, {
    attachTo: document.body,
    props: { steps: STEPS, storageKey: STORAGE_KEY, ...props },
  });
}

describe('WelcomeTour', () => {
  beforeEach(() => {
    resetShortcutBlockingOverlaysForTest();
    localStorage.removeItem(STORAGE_KEY);
    for (const id of ['anchor-one', 'anchor-two']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
  });

  afterEach(() => {
    resetShortcutBlockingOverlaysForTest();
    document.body.replaceChildren();
    localStorage.removeItem(STORAGE_KEY);
  });

  it('auto-starts on first run and shows the first step', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    expect(wrapper.find('.tour-tooltip').exists()).toBe(true);
    expect(wrapper.find('.tour-title').text()).toBe('Step one');
    expect(wrapper.find('.tour-progress').text()).toBe('1 / 2');
    wrapper.unmount();
  });

  it('does not auto-start when the storage flag is set', async () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not auto-start when autoStart is false but opens via open()', async () => {
    const wrapper = mountTour({ autoStart: false });
    await nextTick();
    await nextTick();
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    wrapper.vm.open();
    await nextTick();
    expect(wrapper.find('.tour-title').text()).toBe('Step one');
    wrapper.unmount();
  });

  it('navigates with Next/Back, skipping steps whose target is missing', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    const next = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Next' || button.text() === 'Done');
    expect(next).toBeDefined();
    await next?.trigger('click');
    expect(wrapper.find('.tour-title').text()).toBe('Step two');
    // Step "gone" has no anchor, so step two is the last one.
    expect(wrapper.findAll('button').some((button) => button.text() === 'Done')).toBe(true);
    const back = wrapper.findAll('button').find((button) => button.text() === 'Back');
    await back?.trigger('click');
    expect(wrapper.find('.tour-title').text()).toBe('Step one');
    wrapper.unmount();
  });

  it('completes via Done, sets the flag and emits close(true)', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    const clickAction = async (label: string) => {
      const button = wrapper.findAll('button').find((b) => b.text() === label);
      await button?.trigger('click');
    };
    await clickAction('Next');
    await clickAction('Done');
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(wrapper.emitted('close')).toEqual([[true]]);
    wrapper.unmount();
  });

  it('skips via Skip tour, sets the flag and emits close(false)', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    const skip = wrapper.findAll('button').find((button) => button.text() === 'Skip tour');
    await skip?.trigger('click');
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(wrapper.emitted('close')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('closes on Escape as a skip', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    await wrapper.find('.tour-tooltip').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    expect(wrapper.emitted('close')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('registers as a shortcut blocker and traps Tab focus while open', async () => {
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    expect(shortcutBlockingOverlayOpen.value).toBe(true);

    const buttons = wrapper.findAll('button');
    const first = buttons[0].element as HTMLButtonElement;
    const last = buttons[buttons.length - 1].element as HTMLButtonElement;
    last.focus();
    await buttons[buttons.length - 1].trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    const skip = wrapper.findAll('button').find((button) => button.text() === 'Skip tour');
    await skip?.trigger('click');
    expect(shortcutBlockingOverlayOpen.value).toBe(false);
    wrapper.unmount();
  });

  it('stays hidden when no step target exists', async () => {
    document.body.replaceChildren();
    const wrapper = mountTour();
    await nextTick();
    await nextTick();
    expect(wrapper.find('.tour-tooltip').exists()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    wrapper.unmount();
  });

  it('removes viewport listeners on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mountTour({ autoStart: false });

    expect(add).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), true);

    wrapper.unmount();

    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });
});

describe('HintCard', () => {
  it('renders the message and optional title', () => {
    const wrapper = mount(HintCard, { props: { message: 'Drop a clip here', title: 'Empty' } });
    expect(wrapper.find('[role="note"]').exists()).toBe(true);
    expect(wrapper.find('.hint-title').text()).toBe('Empty');
    expect(wrapper.find('.hint-message').text()).toBe('Drop a clip here');
  });

  it('omits the title and action container when not provided', () => {
    const wrapper = mount(HintCard, { props: { message: 'No tracks yet' } });
    expect(wrapper.find('.hint-title').exists()).toBe(false);
    expect(wrapper.find('.hint-action').exists()).toBe(false);
  });

  it('renders the action slot', () => {
    const wrapper = mount(HintCard, {
      props: { message: 'Engine is off' },
      slots: { action: '<button type="button">Start engine</button>' },
    });
    expect(wrapper.find('.hint-action button').text()).toBe('Start engine');
  });
});

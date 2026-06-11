import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MixerFader from '@/components/mixer/MixerFader.vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import { FADER_MAX_DB, FADER_MIN_DB } from '@/ui/mixer/db-scale';

/**
 * Accessibility contract of the highest-traffic interactive widgets: slider
 * semantics on the fader/knob and modal behavior of the template dialog.
 */

describe('MixerFader accessibility', () => {
  it('exposes full slider semantics', () => {
    const wrapper = mount(MixerFader, { props: { valueDb: -6 } });
    const slider = wrapper.find('[role="slider"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('aria-label')).toBe('Strip gain');
    expect(slider.attributes('aria-orientation')).toBe('vertical');
    expect(slider.attributes('aria-valuemin')).toBe(String(FADER_MIN_DB));
    expect(slider.attributes('aria-valuemax')).toBe(String(FADER_MAX_DB));
    expect(slider.attributes('aria-valuenow')).toBe('-6');
    expect(slider.attributes('aria-valuetext')).toContain('dB');
    expect(slider.attributes('tabindex')).toBe('0');
  });

  it('is keyboard operable via arrow keys', async () => {
    const wrapper = mount(MixerFader, { props: { valueDb: -6 } });
    await wrapper.find('[role="slider"]').trigger('keydown', { key: 'ArrowUp' });
    const emitted = wrapper.emitted('change');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]).toEqual([-5, true]);
  });

  it('removes itself from the tab order when disabled', () => {
    const wrapper = mount(MixerFader, { props: { valueDb: 0, disabled: true } });
    expect(wrapper.find('[role="slider"]').attributes('tabindex')).toBe('-1');
  });
});

describe('MixerKnob accessibility', () => {
  it('exposes full slider semantics', () => {
    const wrapper = mount(MixerKnob, {
      props: { value: 25, min: 0, max: 100, label: 'Pan' },
    });
    const slider = wrapper.find('[role="slider"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('aria-label')).toBe('Pan');
    expect(slider.attributes('aria-valuemin')).toBe('0');
    expect(slider.attributes('aria-valuemax')).toBe('100');
    expect(slider.attributes('aria-valuenow')).toBe('25');
    expect(slider.attributes('tabindex')).toBe('0');
  });
});

describe('NewProjectDialog modal accessibility', () => {
  it('marks the dialog as modal with an accessible name', () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-label')).toBe('New project');
  });

  it('keeps Tab cycling inside the dialog', async () => {
    const wrapper = mount(NewProjectDialog, {
      props: { open: true },
      attachTo: document.body,
    });
    const dialog = wrapper.find<HTMLElement>('[role="dialog"]');
    const buttons = wrapper.findAll('button');
    const last = buttons[buttons.length - 1].element;
    last.focus();
    expect(document.activeElement).toBe(last);

    // Tab from the last focusable element wraps to the first.
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(dialog.element.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    wrapper.unmount();
  });

  it('restores focus to the previously focused element on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(NewProjectDialog, {
      props: { open: false },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.find('[role="dialog"]').element);

    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
    trigger.remove();
  });
});

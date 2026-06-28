import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import OpenProjectDialog from '@/components/project/OpenProjectDialog.vue';
import type { StoredProjectInfo } from '@/persistence/opfs';

const projects: StoredProjectInfo[] = [
  { name: 'Alpha', size: 1024 },
  { name: 'Beta', size: 2048 },
  { name: 'Gamma', size: 4096 },
];

describe('OpenProjectDialog', () => {
  it('renders nothing while closed', () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: false, storedProjects: projects },
    });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('exposes the saved projects as a listbox of options', () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: projects },
    });
    const listbox = wrapper.find('[role="listbox"]');
    expect(listbox.exists()).toBe(true);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(projects.length);
  });

  it('tracks the keyboard selection via aria-activedescendant', async () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: projects },
    });
    const listbox = wrapper.find('[role="listbox"]');
    const dialog = wrapper.find('[role="dialog"]');

    const firstId = wrapper.findAll('[role="option"]')[0].attributes('id');
    expect(listbox.attributes('aria-activedescendant')).toBe(firstId);
    expect(wrapper.findAll('[role="option"]')[0].attributes('aria-selected')).toBe('true');

    await dialog.trigger('keydown', { key: 'ArrowDown' });
    const secondId = wrapper.findAll('[role="option"]')[1].attributes('id');
    expect(listbox.attributes('aria-activedescendant')).toBe(secondId);
    expect(wrapper.findAll('[role="option"]')[1].attributes('aria-selected')).toBe('true');

    await dialog.trigger('keydown', { key: 'ArrowUp' });
    expect(listbox.attributes('aria-activedescendant')).toBe(firstId);
  });

  it('clamps the selection at the list bounds', async () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: projects },
    });
    const listbox = wrapper.find('[role="listbox"]');
    const dialog = wrapper.find('[role="dialog"]');

    await dialog.trigger('keydown', { key: 'ArrowUp' });
    expect(listbox.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('[role="option"]')[0].attributes('id'),
    );

    for (let i = 0; i < 5; i += 1) {
      await dialog.trigger('keydown', { key: 'ArrowDown' });
    }
    expect(listbox.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('[role="option"]')[projects.length - 1].attributes('id'),
    );
  });

  it('opens the highlighted project on Enter', async () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: projects },
    });
    const dialog = wrapper.find('[role="dialog"]');
    await dialog.trigger('keydown', { key: 'ArrowDown' });
    await dialog.trigger('keydown', { key: 'Enter' });

    const emitted = wrapper.emitted('openProject') as Array<[string]>;
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe('Beta');
  });

  it('forwards other keys to the shell for Escape and focus handling', async () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: projects },
    });
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('keydown')).toHaveLength(1);
  });

  it('omits aria-activedescendant when there are no saved projects', () => {
    const wrapper = mount(OpenProjectDialog, {
      props: { open: true, storedProjects: [] },
    });
    const listbox = wrapper.find('[role="listbox"]');
    expect(listbox.attributes('aria-activedescendant')).toBeUndefined();
    expect(wrapper.find('.stored-empty').exists()).toBe(true);
  });
});

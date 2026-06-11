import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import type { ProjectDocument } from '@/project/serialization';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@/project/serialization';
import { TEMPLATE_NAMES } from '@/project/templates';

describe('NewProjectDialog', () => {
  it('renders nothing while closed', () => {
    const wrapper = mount(NewProjectDialog, { props: { open: false } });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('lists every built-in template', () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    const options = wrapper.findAll('[role="option"]');
    expect(options).toHaveLength(TEMPLATE_NAMES.length);
    expect(options.map((o) => o.find('.template-label').text())).toEqual([
      'Empty',
      'Band',
      'GM Orchestra',
      'Programming',
      'Transcription',
    ]);
  });

  it('previews the selected template tracks', async () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    expect(wrapper.find('.preview-empty').text()).toBe('No tracks');

    const band = wrapper.findAll('[role="option"]')[1];
    await band.trigger('click');
    expect(band.attributes('aria-selected')).toBe('true');
    const tracks = wrapper.findAll('.preview-track');
    expect(tracks.map((t) => t.text())).toEqual(['Drums', 'Bass', 'Piano', 'Guitar', 'Vocal']);
  });

  it('emits a fresh document for the selected template on Create', async () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    await wrapper.findAll('[role="option"]')[1].trigger('click');
    const create = wrapper.findAll('button').find((b) => b.text() === 'Create');
    await create?.trigger('click');
    await create?.trigger('click');

    const emitted = wrapper.emitted('create') as Array<
      [{ document: ProjectDocument; template: string }]
    >;
    expect(emitted).toHaveLength(2);
    expect(emitted[0][0].template).toBe('band');
    expect(emitted[0][0].document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(emitted[0][0].document.name).toBe('Band');
    expect(emitted[0][0].document.tracks).toHaveLength(5);
    // Each Create hands out a private copy the shell may mutate freely.
    expect(emitted[0][0].document).not.toBe(emitted[1][0].document);
  });

  it('emits cancel from the Cancel button, Escape and the overlay', async () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel');
    await cancel?.trigger('click');
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    await wrapper.find('.dialog-overlay').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(3);
  });

  it('supports keyboard selection and Enter-to-create', async () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true } });
    const dialog = wrapper.find('[role="dialog"]');
    await dialog.trigger('keydown', { key: 'ArrowDown' });
    await dialog.trigger('keydown', { key: 'ArrowDown' });
    await dialog.trigger('keydown', { key: 'ArrowUp' });
    await dialog.trigger('keydown', { key: 'Enter' });

    const emitted = wrapper.emitted('create') as Array<[{ template: string }]>;
    expect(emitted[0][0].template).toBe('band');
  });

  it('shows the unsaved-changes warning only when requested', () => {
    const clean = mount(NewProjectDialog, { props: { open: true } });
    expect(clean.find('.dialog-warning').exists()).toBe(false);

    const dirty = mount(NewProjectDialog, { props: { open: true, unsavedChanges: true } });
    expect(dirty.find('.dialog-warning').text()).toContain('unsaved changes');
  });

  it('renders custom warning slot content', () => {
    const wrapper = mount(NewProjectDialog, {
      props: { open: true, unsavedChanges: true },
      slots: { warning: 'Project "Demo" was edited 5 minutes ago.' },
    });
    expect(wrapper.find('.dialog-warning').text()).toBe('Project "Demo" was edited 5 minutes ago.');
  });
});

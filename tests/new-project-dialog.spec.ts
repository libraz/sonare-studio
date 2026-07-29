import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import type { ProjectDocument } from '@/project/serialization';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@/project/serialization';
import { TEMPLATE_NAMES } from '@/project/templates';

// AppModal teleports its content to <body>, so the dialog is queried through
// the document rather than the wrapper, and events are dispatched natively.

let wrapper: VueWrapper | null = null;

function open(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(NewProjectDialog, {
    props: { open: true, ...props },
    attachTo: document.body,
  });
  return wrapper;
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function qa<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(document.body.querySelectorAll<T>(selector));
}

function button(label: string): HTMLButtonElement | undefined {
  return qa<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === label);
}

async function keydown(key: string): Promise<void> {
  q('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await nextTick();
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('NewProjectDialog', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(NewProjectDialog, { props: { open: false }, attachTo: document.body });
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('lists every built-in template', () => {
    open();
    const listbox = q<HTMLElement>('[role="listbox"]');
    expect(listbox?.tabIndex).toBe(0);
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('new-project-template-empty');
    const options = qa('[role="option"]');
    expect(options).toHaveLength(TEMPLATE_NAMES.length);
    expect(options.map((o) => o.querySelector('.template-label')?.textContent)).toEqual([
      'Empty',
      'Band',
      'GM Orchestra',
      'Programming',
      'Transcription',
    ]);
  });

  it('previews the selected template tracks', async () => {
    open();
    expect(q('.empty-state')?.textContent?.trim()).toBe('No tracks');

    const band = qa('[role="option"]')[1];
    band.click();
    await nextTick();
    expect(band.getAttribute('aria-selected')).toBe('true');
    const tracks = qa('.preview-track');
    expect(tracks.map((t) => t.textContent?.trim())).toEqual([
      'Drums',
      'Bass',
      'Piano',
      'Guitar',
      'Vocal',
    ]);
  });

  it('emits a fresh document for the selected template on Create', async () => {
    open();
    qa('[role="option"]')[1].click();
    await nextTick();
    button('Create')?.click();
    button('Create')?.click();
    await nextTick();

    const emitted = wrapper?.emitted('create') as Array<
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
    open();
    button('Cancel')?.click();
    await keydown('Escape');
    q('.modal-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper?.emitted('cancel')).toHaveLength(3);
  });

  it('supports keyboard selection and Enter-to-create', async () => {
    open();
    await keydown('ArrowDown');
    await keydown('ArrowDown');
    await keydown('ArrowUp');
    await keydown('Enter');

    const emitted = wrapper?.emitted('create') as Array<[{ template: string }]>;
    expect(emitted[0][0].template).toBe('band');
  });

  it('updates the template listbox active descendant during keyboard selection', async () => {
    open();
    const listbox = q<HTMLElement>('[role="listbox"]')!;
    listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick();

    expect(listbox.getAttribute('aria-activedescendant')).toBe('new-project-template-band');
  });

  it('does not turn Enter on Cancel into the dialog default action', async () => {
    open();
    button('Cancel')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();

    expect(wrapper?.emitted('create')).toBeUndefined();
  });

  it('shows the unsaved-changes warning only when requested', () => {
    open();
    expect(q('.dialog-warning')).toBeNull();
    wrapper?.unmount();
    document.body.innerHTML = '';

    open({ unsavedChanges: true });
    expect(q('.dialog-warning')?.textContent).toContain('unsaved changes');
  });

  it('renders custom warning slot content', () => {
    wrapper = mount(NewProjectDialog, {
      props: { open: true, unsavedChanges: true },
      slots: { warning: 'Project "Demo" was edited 5 minutes ago.' },
      attachTo: document.body,
    });
    expect(q('.dialog-warning')?.textContent?.trim()).toBe(
      'Project "Demo" was edited 5 minutes ago.',
    );
  });
});

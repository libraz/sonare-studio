import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import OpenProjectDialog from '@/components/project/OpenProjectDialog.vue';
import type { StoredProjectInfo } from '@/persistence/opfs';

// AppModal teleports the dialog to <body>, so it is queried through the document
// and keyboard events are dispatched natively on the dialog card.

const projects: StoredProjectInfo[] = [
  { name: 'Alpha', size: 1024 },
  { name: 'Beta', size: 2048 },
  { name: 'Gamma', size: 4096 },
];

let wrapper: VueWrapper | null = null;

function open(storedProjects: StoredProjectInfo[]): VueWrapper {
  wrapper = mount(OpenProjectDialog, {
    props: { open: true, storedProjects },
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

function activeDescendant(): string | null {
  return q('[role="listbox"]')?.getAttribute('aria-activedescendant') ?? null;
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

describe('OpenProjectDialog', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(OpenProjectDialog, {
      props: { open: false, storedProjects: projects },
      attachTo: document.body,
    });
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('exposes the saved projects as a listbox of options', () => {
    open(projects);
    const listbox = q<HTMLElement>('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.tabIndex).toBe(0);
    const options = qa<HTMLButtonElement>('[role="option"]');
    expect(options).toHaveLength(projects.length);
    expect(options.every((option) => option.tagName === 'BUTTON')).toBe(true);
    expect(options.every((option) => option.querySelector('button') === null)).toBe(true);
  });

  it('tracks the keyboard selection via aria-activedescendant', async () => {
    open(projects);
    const options = qa('[role="option"]');
    const firstId = options[0].id;
    expect(activeDescendant()).toBe(firstId);
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    await keydown('ArrowDown');
    const secondId = qa('[role="option"]')[1].id;
    expect(activeDescendant()).toBe(secondId);
    expect(qa('[role="option"]')[1].getAttribute('aria-selected')).toBe('true');

    await keydown('ArrowUp');
    expect(activeDescendant()).toBe(firstId);
  });

  it('clamps the selection at the list bounds', async () => {
    open(projects);
    await keydown('ArrowUp');
    expect(activeDescendant()).toBe(qa('[role="option"]')[0].id);

    for (let i = 0; i < 5; i += 1) {
      await keydown('ArrowDown');
    }
    expect(activeDescendant()).toBe(qa('[role="option"]')[projects.length - 1].id);
  });

  it('opens the highlighted project on Enter', async () => {
    open(projects);
    await keydown('ArrowDown');
    await keydown('Enter');

    const emitted = wrapper?.emitted('openProject') as Array<[string]>;
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe('Beta');
  });

  it('emits a rename request for the selected saved project row', async () => {
    open(projects);
    q<HTMLButtonElement>('.stored-rename')?.click();
    await nextTick();

    expect(wrapper?.emitted('renameProject')).toEqual([['Alpha']]);
  });

  it('does not turn Enter on Delete into opening the highlighted project', async () => {
    open(projects);
    q<HTMLButtonElement>('.stored-delete')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();

    expect(wrapper?.emitted('openProject')).toBeUndefined();
  });

  it('emits close on Escape (AppModal owns dismissal)', async () => {
    open(projects);
    await keydown('Escape');
    expect(wrapper?.emitted('close')).toHaveLength(1);
  });

  it('omits aria-activedescendant when there are no saved projects', () => {
    open([]);
    expect(activeDescendant()).toBeNull();
    expect(q('.stored-empty')).not.toBeNull();
  });
});

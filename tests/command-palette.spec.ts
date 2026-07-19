import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import CommandPalette, { type CommandPaletteItem } from '@/components/shell/CommandPalette.vue';

let wrapper: VueWrapper | null = null;

function mountPalette(commands: CommandPaletteItem[]): VueWrapper {
  wrapper = mount(CommandPalette, {
    props: { open: true, commands },
    attachTo: document.body,
  });
  return wrapper;
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('CommandPalette', () => {
  it('keeps combobox focus while exposing the active option', async () => {
    mountPalette([
      { id: 'save', label: 'Save project', run: vi.fn() },
      { id: 'open', label: 'Open project', run: vi.fn() },
    ]);
    await nextTick();
    await nextTick();

    const input = q<HTMLInputElement>('[role="combobox"]')!;
    const list = q<HTMLElement>('[role="listbox"]')!;
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(q<HTMLElement>('[role="option"]')?.id);
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await nextTick();
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(document.activeElement).toBe(input);
  });

  it('scrolls the active row into view when keyboard navigation moves it', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mountPalette([
      { id: 'save', label: 'Save project', run: vi.fn() },
      { id: 'open', label: 'Open project', run: vi.fn() },
      { id: 'close', label: 'Close project', run: vi.fn() },
    ]);
    await nextTick();
    await nextTick();

    const input = q<HTMLInputElement>('[role="combobox"]')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await nextTick();
    await nextTick();

    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    // The now-active second row must be scrolled into view.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[1]);
  });

  it('filters commands and runs the selected command with Enter', async () => {
    const save = vi.fn();
    const open = vi.fn();
    mountPalette([
      { id: 'save', label: 'File: Save project', hint: 'Cmd+S', run: save },
      { id: 'open', label: 'File: Open project', hint: 'Cmd+O', run: open },
    ]);

    const input = q<HTMLInputElement>('input[aria-label="Search commands"]');
    expect(input).not.toBeNull();
    input!.value = 'open';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(document.body.textContent).toContain('File: Open project');
    expect(document.body.textContent).not.toContain('File: Save project');

    q('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(wrapper?.emitted('close')).toHaveLength(1);
  });

  it('does not double-run when Enter originates from an option button', async () => {
    const run = vi.fn();
    mountPalette([{ id: 'save', label: 'Save project', run }]);
    q('[role="option"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();

    expect(run).not.toHaveBeenCalled();
  });
});

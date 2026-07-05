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
});

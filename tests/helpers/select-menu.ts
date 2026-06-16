import { flushPromises, type VueWrapper } from '@vue/test-utils';

/**
 * Test helpers for driving the custom `SelectMenu` component, which replaced the
 * native `<select>`. The trigger is a `button.select-trigger` (the passthrough
 * class lands on the `span.select-menu` root); the option list is teleported to
 * `document.body` as `ul.select-list > li.select-option` and only exists while
 * the menu is open.
 *
 * `selector` targets a specific SelectMenu by its passthrough class or a
 * containing element, e.g. `.format-select` or `[data-testid="sort"]`.
 */

/** Opens the SelectMenu matched by `selector` within the wrapper. */
export async function openSelect(wrapper: VueWrapper, selector: string): Promise<void> {
  await wrapper.get(`${selector} .select-trigger`).trigger('click');
  await flushPromises();
}

/** Labels of the options in the currently-open menu, in display order. */
export function openOptionLabels(): string[] {
  return Array.from(document.querySelectorAll('.select-list .select-option-label')).map((node) =>
    (node.textContent ?? '').trim(),
  );
}

/** Clicks the option with the given visible label in the open menu. */
export async function chooseOption(label: string): Promise<void> {
  const options = Array.from(document.querySelectorAll<HTMLElement>('.select-list .select-option'));
  const target = options.find(
    (li) => (li.querySelector('.select-option-label')?.textContent ?? '').trim() === label,
  );
  if (!target) {
    throw new Error(
      `SelectMenu option "${label}" not found; available: ${openOptionLabels().join(', ')}`,
    );
  }
  target.click();
  await flushPromises();
}

/**
 * Opens the SelectMenu matched by `selector` and picks the option labelled
 * `label`. The one-call equivalent of the native `select.setValue(...)`.
 */
export async function selectOption(
  wrapper: VueWrapper,
  selector: string,
  label: string,
): Promise<void> {
  await openSelect(wrapper, selector);
  await chooseOption(label);
}

/** The visible label currently shown on the SelectMenu trigger. */
export function selectValueText(wrapper: VueWrapper, selector: string): string {
  return wrapper.get(`${selector} .select-value`).text();
}

/**
 * Reads every option label for the SelectMenu matched by `selector` by opening
 * it, snapshotting the labels and closing it again (Escape). Useful for
 * "lists the available options" assertions.
 */
export async function readOptionLabels(wrapper: VueWrapper, selector: string): Promise<string[]> {
  await openSelect(wrapper, selector);
  const labels = openOptionLabels();
  await wrapper.get(`${selector} .select-trigger`).trigger('keydown', { key: 'Escape' });
  await flushPromises();
  return labels;
}

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StepGrid from '@/components/step-sequencer/StepGrid.vue';
import { createDrumPattern, type StepPattern, withStep } from '@/ui/step-sequencer/pattern';

function mountGrid(pattern: StepPattern, selectedRow = 0) {
  return mount(StepGrid, { props: { pattern, selectedRow } });
}

function cell(wrapper: ReturnType<typeof mountGrid>, row: number, step: number) {
  return wrapper.find(`[data-row="${row}"][data-step="${step}"]`);
}

/**
 * Dispatches a bubbling pointerdown as a MouseEvent: test-utils trigger()
 * cannot assign the read-only `button` property on jsdom events, while the
 * MouseEvent constructor accepts it directly.
 */
async function pointerDown(
  wrapper: ReturnType<typeof mountGrid>,
  row: number,
  step: number,
  button = 0,
): Promise<void> {
  cell(wrapper, row, step).element.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button }),
  );
  await wrapper.vm.$nextTick();
}

describe('StepGrid', () => {
  it('renders one cell per row and step', () => {
    const pattern = createDrumPattern(8);
    const wrapper = mountGrid(pattern);
    expect(wrapper.findAll('[data-step]')).toHaveLength(pattern.rows.length * 8);
  });

  it('toggles an inactive cell on via pointerdown', async () => {
    const wrapper = mountGrid(createDrumPattern(8));
    await pointerDown(wrapper, 2, 3);
    expect(wrapper.emitted('set-step')).toEqual([[2, 3, true]]);
    expect(wrapper.emitted('select-row')).toEqual([[2]]);
  });

  it('toggles an active cell off via pointerdown', async () => {
    const pattern = withStep(createDrumPattern(8), 1, 0, { active: true });
    const wrapper = mountGrid(pattern);
    await pointerDown(wrapper, 1, 0);
    expect(wrapper.emitted('set-step')).toEqual([[1, 0, false]]);
  });

  it('erases with the right button and ignores already-inactive cells', async () => {
    const pattern = withStep(createDrumPattern(8), 0, 1, { active: true });
    const wrapper = mountGrid(pattern);
    await pointerDown(wrapper, 0, 1, 2);
    expect(wrapper.emitted('set-step')).toEqual([[0, 1, false]]);

    await wrapper.trigger('pointerup');
    await pointerDown(wrapper, 0, 2, 2);
    // Erasing an inactive cell changes nothing.
    expect(wrapper.emitted('set-step')).toEqual([[0, 1, false]]);
  });

  it('selects a row from its label button', async () => {
    const wrapper = mountGrid(createDrumPattern(8));
    await wrapper.findAll('.row-label')[4].trigger('click');
    expect(wrapper.emitted('select-row')).toEqual([[4]]);
  });

  it('shows velocity as the cell fill height', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 0, { active: true, velocity: 127 });
    pattern = withStep(pattern, 0, 1, { active: true, velocity: 64 });
    const wrapper = mountGrid(pattern);
    expect(cell(wrapper, 0, 0).find('.cell-fill').attributes('style')).toContain('height: 100%');
    expect(cell(wrapper, 0, 1).find('.cell-fill').attributes('style')).toContain('height: 50%');
    expect(cell(wrapper, 0, 2).find('.cell-fill').exists()).toBe(false);
  });

  it('marks the muted row and the selected row', () => {
    let pattern = createDrumPattern(8);
    pattern = {
      ...pattern,
      rows: pattern.rows.map((row, i) => (i === 1 ? { ...row, muted: true } : row)),
    };
    const wrapper = mountGrid(pattern, 1);
    const rows = wrapper.findAll('.grid-row');
    expect(rows[1].classes()).toContain('row-selected');
    expect(rows[1].classes()).toContain('row-muted');
    expect(rows[0].classes()).not.toContain('row-selected');
  });
});

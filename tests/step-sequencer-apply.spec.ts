import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { addNote, canUndo, clearHistory, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { type StepPattern, withStep, withSwing } from '@/ui/step-sequencer/pattern';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Typed view of the component's exposed state and actions. */
interface SequencerVm {
  pattern: StepPattern;
  selectedRow: number;
  applyToClip: () => void;
  pullFromClip: () => void;
}

describe('StepSequencer (apply / pull integration)', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function mountSequencer() {
    const wrapper = mount(StepSequencer);
    await flushPromises();
    return wrapper;
  }

  /**
   * Presses a grid cell as a real bubbling MouseEvent (test-utils trigger()
   * cannot assign the read-only `button` property on jsdom events).
   */
  async function pressCell(
    wrapper: Awaited<ReturnType<typeof mountSequencer>>,
    row: number,
    step: number,
  ): Promise<void> {
    wrapper
      .find(`[data-row="${row}"][data-step="${step}"]`)
      .element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();
    await wrapper.find('.step-grid').trigger('pointerup');
  }

  it('paints steps from the grid and bakes them into the active clip', async () => {
    const wrapper = await mountSequencer();
    const kickRow = (wrapper.vm as unknown as SequencerVm).pattern.rows.length - 1;
    await pressCell(wrapper, kickRow, 0);
    await pressCell(wrapper, kickRow, 8);

    await wrapper.find('[data-test="apply"]').trigger('click');

    expect(store.notes).toHaveLength(2);
    expect(store.notes[0]).toMatchObject({
      pitch: 36,
      velocity: 96,
      startPpq: 0,
      durationPpq: 0.125,
      channel: 9,
    });
    expect(store.notes[1].startPpq).toBe(2);
    expect(wrapper.emitted('applied')).toEqual([[2]]);
    expect(wrapper.find('[data-test="status"]').text()).toContain('Applied 2 notes');
  });

  it('re-applies count-stable edits as a single undo entry', async () => {
    const wrapper = await mountSequencer();
    const vm = wrapper.vm as unknown as SequencerVm;
    const kickRow = vm.pattern.rows.length - 1;
    vm.pattern = withStep(vm.pattern, kickRow, 0, { active: true, velocity: 100 });
    vm.pattern = withStep(vm.pattern, kickRow, 4, { active: true, velocity: 100 });
    vm.applyToClip();
    expect(store.notes.map((note) => note.velocity)).toEqual([100, 100]);

    clearHistory();
    vm.pattern = withStep(vm.pattern, kickRow, 0, { velocity: 64 });
    vm.pattern = withStep(vm.pattern, kickRow, 4, { velocity: 72 });
    vm.pattern = withSwing(vm.pattern, 50);
    vm.applyToClip();
    expect(store.notes.map((note) => note.velocity)).toEqual([64, 72]);

    // One updateNotes call = one undo entry for the whole re-bake.
    expect(undo()).toBe(true);
    expect(store.notes.map((note) => note.velocity)).toEqual([100, 100]);
    expect(canUndo()).toBe(false);
  });

  it('removing steps deletes the surplus notes in one entry', async () => {
    const wrapper = await mountSequencer();
    const vm = wrapper.vm as unknown as SequencerVm;
    const kickRow = vm.pattern.rows.length - 1;
    vm.pattern = withStep(vm.pattern, kickRow, 0, { active: true });
    vm.pattern = withStep(vm.pattern, kickRow, 4, { active: true });
    vm.pattern = withStep(vm.pattern, kickRow, 8, { active: true });
    vm.applyToClip();
    expect(store.notes).toHaveLength(3);

    clearHistory();
    vm.pattern = withStep(vm.pattern, kickRow, 8, { active: false });
    vm.applyToClip();
    expect(store.notes).toHaveLength(2);
    expect(undo()).toBe(true);
    expect(store.notes).toHaveLength(3);
    expect(canUndo()).toBe(false);
  });

  it('reports when the clip already matches the pattern', async () => {
    const wrapper = await mountSequencer();
    const vm = wrapper.vm as unknown as SequencerVm;
    const kickRow = vm.pattern.rows.length - 1;
    vm.pattern = withStep(vm.pattern, kickRow, 0, { active: true });
    vm.applyToClip();
    const before = canUndo();
    vm.applyToClip();
    await flushPromises();
    expect(wrapper.find('[data-test="status"]').text()).toContain('already matches');
    expect(canUndo()).toBe(before);
  });

  it('pulls existing clip notes back onto the grid', async () => {
    addNote({ pitch: 36, startPpq: 0, durationPpq: 0.125, velocity: 100, channel: 9 });
    addNote({ pitch: 38, startPpq: 1.0625, durationPpq: 0.25, velocity: 80, channel: 9 });

    const wrapper = await mountSequencer();
    await wrapper.find('[data-test="pull"]').trigger('click');

    const vm = wrapper.vm as unknown as SequencerVm;
    const kick = vm.pattern.rows.find((row) => row.pitch === 36);
    const snare = vm.pattern.rows.find((row) => row.pitch === 38);
    expect(kick?.steps[0]).toMatchObject({ active: true, velocity: 100 });
    expect(snare?.steps[4].active).toBe(true);
    expect(snare?.steps[4].velocity).toBe(80);
    expect(snare?.steps[4].gate).toBeCloseTo(1, 9);
    expect(snare?.steps[4].offset).toBeCloseTo(0.25, 9);
    expect(wrapper.emitted('pulled')).toEqual([[2]]);
  });

  it('applies a euclidean fill to the selected row through the popover', async () => {
    const wrapper = await mountSequencer();
    await wrapper.find('[data-test="euclid-toggle"]').trigger('click');
    const pulses = wrapper.find('.euclid-popover input[type="number"]');
    await pulses.setValue('3');
    await wrapper.find('[data-test="euclid-apply"]').trigger('click');

    const vm = wrapper.vm as unknown as SequencerVm;
    const flags = vm.pattern.rows[0].steps.map((step) => step.active);
    expect(flags.filter(Boolean)).toHaveLength(3);
    expect(flags[0]).toBe(true);
  });

  it('randomizes deterministically from the seed input', async () => {
    const wrapper = await mountSequencer();
    const seedInput = wrapper.find('input[aria-label="Random seed"]');
    await seedInput.setValue('123');
    await seedInput.trigger('change');
    await wrapper.find('[data-test="fill"]').trigger('click');
    const first = JSON.stringify((wrapper.vm as unknown as SequencerVm).pattern.rows);

    await wrapper.find('[data-test="fill"]').trigger('click');
    const second = JSON.stringify((wrapper.vm as unknown as SequencerVm).pattern.rows);
    expect(second).toBe(first);
  });
});

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { StepPattern } from '@/ui/step-sequencer/pattern';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

interface SequencerVm {
  pattern: StepPattern;
  selectedRow: number;
}

type Wrapper = Awaited<ReturnType<typeof mountSequencer>>;

async function mountSequencer() {
  const wrapper = mount(StepSequencer, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function fire(target: Element, type: string, x = 0, y = 0): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

function cell(wrapper: Wrapper, row: number, step: number): Element {
  return wrapper.get(`[data-row="${row}"][data-step="${step}"]`).element;
}

/** Gives the parameter lane a 160x100 box so pointer positions map to steps and values. */
function layoutLane(wrapper: Wrapper): Element {
  const lane = wrapper.get('.param-lane').element;
  Object.assign(lane, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 160, height: 100 }),
  });
  return lane;
}

describe('StepSequencer pointer gestures', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('reverts a whole paint stroke with one undo', async () => {
    const wrapper = await mountSequencer();
    const vm = wrapper.vm as unknown as SequencerVm;
    const before = vm.pattern.rows[0].steps.map((step) => step.active);
    const hovered = [cell(wrapper, 0, 1), cell(wrapper, 0, 2), cell(wrapper, 0, 3)];
    let next = 0;
    document.elementFromPoint = vi.fn(() => hovered[next++] ?? null);

    fire(cell(wrapper, 0, 0), 'pointerdown');
    for (let i = 0; i < 3; i++) fire(wrapper.get('.step-grid').element, 'pointermove');
    fire(wrapper.get('.step-grid').element, 'pointerup');
    const painted = vm.pattern.rows[0].steps.slice(0, 4).map((step) => step.active);
    expect(new Set(painted).size).toBe(1);
    expect(painted[0]).toBe(!before[0]);

    await wrapper.vm.$nextTick();
    await wrapper.get('[data-test="pattern-undo"]').trigger('click');

    expect(vm.pattern.rows[0].steps.map((step) => step.active)).toEqual(before);
    expect(wrapper.get('[data-test="pattern-undo"]').attributes('disabled')).toBeDefined();
  });

  it('records one entry for a long lane drag and none for a repeat that changes nothing', async () => {
    const wrapper = await mountSequencer();
    const vm = wrapper.vm as unknown as SequencerVm;
    const defaultVelocity = vm.pattern.rows[0].steps[0].velocity;
    fire(cell(wrapper, 0, 5), 'pointerdown');
    fire(wrapper.get('.step-grid').element, 'pointerup');
    const lane = layoutLane(wrapper);
    vm.selectedRow = 0;
    await wrapper.vm.$nextTick();

    fire(lane, 'pointerdown', 5, 80);
    for (let i = 0; i < 150; i++) fire(lane, 'pointermove', 5, 80 - (i % 60));
    fire(lane, 'pointerup', 5, 20);
    await wrapper.vm.$nextTick();
    const dragged = vm.pattern.rows[0].steps[0].velocity;
    expect(dragged).not.toBe(defaultVelocity);

    fire(lane, 'pointerdown', 5, 51);
    fire(lane, 'pointerup', 5, 51);
    await wrapper.vm.$nextTick();
    expect(vm.pattern.rows[0].steps[0].velocity).toBe(dragged);

    await wrapper.get('[data-test="pattern-undo"]').trigger('click');
    expect(vm.pattern.rows[0].steps[0].velocity).toBe(defaultVelocity);
    expect(vm.pattern.rows[0].steps[5].active).toBe(true);
  });
});

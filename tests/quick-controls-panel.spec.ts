import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickControls from '@/components/devices/QuickControls.vue';
import { addInsert, clearHistory, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/**
 * Dispatches a pointer event as a MouseEvent carrying a pointerId: jsdom has
 * no PointerEvent constructor and its MouseEvent.button is getter-only, so
 * test-utils trigger() cannot assign pointer fields.
 */
function firePointer(
  wrapper: { element: Element },
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { button?: number; clientY?: number; pointerId?: number; shiftKey?: boolean } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  wrapper.element.dispatchEvent(event);
}

describe('QuickControls.vue', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  it('renders one knob per quick control with name and value readouts', () => {
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
    });
    const knobs = wrapper.findAll('.qc-knob');
    expect(knobs).toHaveLength(8);
    expect(wrapper.findAll('.qc-name').map((n) => n.text())).toContain('Cutoff');
    // Fake preset catalog reports cutoffHz 12000 for the default e-piano.
    expect(wrapper.find('[data-control="cutoffHz"]').attributes('aria-valuenow')).toBe('12000');
  });

  it('shows an empty state for targets without controls', async () => {
    const { setTrackInstrument } = await import('@/project/commands');
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm' });
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
    });
    expect(wrapper.find('.empty-state').exists()).toBe(true);
    expect(wrapper.findAll('.qc-knob')).toHaveLength(0);
  });

  it('coalesces a knob drag into one undoable command gesture', async () => {
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
    });
    const knob = wrapper.find('[data-control="cutoffHz"]');
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 1, clientY: 200 });
    firePointer(knob, 'pointermove', { pointerId: 1, clientY: 170 });
    firePointer(knob, 'pointermove', { pointerId: 1, clientY: 150 });
    firePointer(knob, 'pointerup', { pointerId: 1, clientY: 150 });
    await wrapper.vm.$nextTick();

    // 50px up over a 150px sweep of the 19980 Hz range from the 12000 base.
    const instrument = store.tracks[0].instrument as { patch: { cutoffHz?: number } };
    expect(instrument.patch.cutoffHz).toBeCloseTo(12000 + (50 / 150) * 19980, 3);

    // The whole drag is one history entry; undoing it restores the default.
    expect(undo()).toBe(true);
    expect(store.tracks[0].instrument).toBeUndefined();
    expect(undo()).toBe(false);
  });

  it('updates the knob readout live while dragging', async () => {
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
    });
    const knob = wrapper.find('[data-control="gain"]');
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 2, clientY: 100 });
    firePointer(knob, 'pointermove', { pointerId: 2, clientY: 130 });
    await wrapper.vm.$nextTick();
    // Fake preset gain base 0.8, dragged down 30px over the [0, 2] range.
    const now = Number(wrapper.find('[data-control="gain"]').attributes('aria-valuenow'));
    expect(now).toBeCloseTo(0.4);
  });

  it('drives insert parameters through setInsertParam', async () => {
    addInsert(trackId, 'dynamics.compressor');
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'insert', trackId, index: 0 } },
    });
    const knob = wrapper.find('[data-control="thresholdDb"]');
    expect(knob.exists()).toBe(true);
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 3, clientY: 100 });
    firePointer(knob, 'pointermove', { pointerId: 3, clientY: 250 });
    firePointer(knob, 'pointerup', { pointerId: 3, clientY: 250 });
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBe(-60);
  });

  it('adjusts values from the keyboard as committed steps', async () => {
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
    });
    const knob = wrapper.find('[data-control="drive"]');
    await knob.trigger('keydown', { key: 'ArrowUp' });
    const instrument = store.tracks[0].instrument as { patch: { drive?: number } };
    expect(instrument.patch.drive).toBeCloseTo(0.02);
  });
});

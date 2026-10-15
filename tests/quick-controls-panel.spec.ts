import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickControls from '@/components/devices/QuickControls.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import { insertAutomationParam, instrumentAutomationParam } from '@/project/automation';
import { addInsert, clearHistory, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { resetAutomationStripModes, setAutomationStripMode } from '@/ui/mixer/automation-mode';

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
    resetAutomationStripModes();
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

    // Cutoff uses a logarithmic sweep; the 50px upward drag from 12 kHz
    // reaches the 20 kHz upper bound.
    const instrument = store.tracks[0].instrument as { patch: { cutoffHz?: number } };
    expect(instrument.patch.cutoffHz).toBe(20_000);

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

  it('renders inherited amp values from the selected preset and hides construction controls', () => {
    addInsert(trackId, 'saturation.ampSim', { presetIndex: 5 });
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'insert', trackId, index: 0 } },
    });

    expect(wrapper.find('[data-control="drive"]').attributes('aria-valuenow')).toBe('0.8');
    expect(wrapper.find('[data-control="micDistanceCm"]').exists()).toBe(false);
    expect(wrapper.find('[data-control="ampModel"]').exists()).toBe(false);
  });

  it('touch-records an amp realtime knob while construction controls stay unavailable', async () => {
    addInsert(trackId, 'saturation.ampSim', { presetIndex: 5 });
    setAutomationStripMode(trackId, 'touch');
    const scheduled: unknown[] = [];
    const wrapper = mount(QuickControls, {
      props: {
        target: { type: 'insert', trackId, index: 0 },
        positionPpq: () => 0,
        positionSample: () => 512,
        isPlaying: true,
        scheduleAutomationWrite: (...args: unknown[]) => scheduled.push(args),
      },
    });
    const drive = wrapper.find('[data-control="drive"]');
    firePointer(drive, 'pointerdown', { button: 0, pointerId: 8, clientY: 100 });
    firePointer(drive, 'pointermove', { pointerId: 8, clientY: 130 });
    firePointer(drive, 'pointerup', { pointerId: 8, clientY: 130 });
    await wrapper.vm.$nextTick();

    const insert = store.tracks[0].mixer?.inserts[0];
    const param = insertAutomationParam(insert?.id as string, 'drive');
    expect(insert?.params.drive).toBeUndefined();
    expect(
      store.automationLanes.find((lane) => lane.param === param)?.points.length,
    ).toBeGreaterThan(0);
    expect(scheduled[0]).toEqual([
      trackId,
      param,
      expect.objectContaining({ ppq: 0, samplePos: 512 }),
    ]);
  });

  it('renders typed insert controls as toggles and enum menus', async () => {
    addInsert(trackId, 'dynamics.compressor');
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'insert', trackId, index: 0 } },
    });

    expect(wrapper.findAll('.qc-toggle')).toHaveLength(2);
    expect(wrapper.find('.qc-select').exists()).toBe(true);

    await wrapper.find('.qc-toggle').trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params.autoMakeup).toBe(true);

    wrapper.findComponent({ name: 'SelectMenu' }).vm.$emit('change', 2);
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.inserts[0].params.detector).toBe(2);
  });

  it('touch-records an insert knob into an automation lane in a write mode', async () => {
    addInsert(trackId, 'dynamics.compressor');
    // The strip is armed for touch recording; the playhead getter is supplied.
    setAutomationStripMode(trackId, 'touch');
    const scheduled: unknown[] = [];
    const wrapper = mount(QuickControls, {
      props: {
        target: { type: 'insert', trackId, index: 0 },
        positionPpq: () => 0,
        positionSample: () => 256,
        isPlaying: true,
        scheduleAutomationWrite: (...args: unknown[]) => scheduled.push(args),
      },
    });
    const knob = wrapper.find('[data-control="thresholdDb"]');
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 5, clientY: 100 });
    firePointer(knob, 'pointermove', { pointerId: 5, clientY: 130 });
    firePointer(knob, 'pointerup', { pointerId: 5, clientY: 130 });
    await wrapper.vm.$nextTick();

    // The drag wrote a lane, not the manual parameter (which stays unset).
    expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBeUndefined();
    const param = insertAutomationParam(
      store.tracks[0].mixer?.inserts[0].id as string,
      'thresholdDb',
    );
    const lane = store.automationLanes.find((l) => l.target === trackId && l.param === param);
    expect(lane).toBeDefined();
    expect(lane?.points.length).toBeGreaterThan(0);
    expect(scheduled[0]).toEqual([
      trackId,
      param,
      expect.objectContaining({ ppq: 0, samplePos: 256 }),
    ]);
  });

  it('applies a construction-only insert key in a write mode instead of recording an inert lane', async () => {
    addInsert(trackId, 'dynamics.limiter');
    setAutomationStripMode(trackId, 'latch');
    const wrapper = mount(QuickControls, {
      props: {
        target: { type: 'insert', trackId, index: 0 },
        positionPpq: () => 0,
        isPlaying: true,
        scheduleAutomationWrite: vi.fn(),
      },
    });
    const knob = wrapper.find('[data-control="lookaheadMs"]');
    expect(knob.exists()).toBe(true);
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 7, clientY: 100 });
    firePointer(knob, 'pointermove', { pointerId: 7, clientY: 40 });
    firePointer(knob, 'pointerup', { pointerId: 7, clientY: 40 });
    await wrapper.vm.$nextTick();

    expect(store.tracks[0].mixer?.inserts[0].params.lookaheadMs).toEqual(expect.any(Number));
    expect(store.automationLanes).toHaveLength(0);
  });

  it('still drives the insert parameter manually when no write mode is armed', async () => {
    addInsert(trackId, 'dynamics.compressor');
    const wrapper = mount(QuickControls, {
      props: {
        target: { type: 'insert', trackId, index: 0 },
        positionPpq: () => 0,
        isPlaying: false,
      },
    });
    const knob = wrapper.find('[data-control="thresholdDb"]');
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 6, clientY: 100 });
    firePointer(knob, 'pointermove', { pointerId: 6, clientY: 250 });
    firePointer(knob, 'pointerup', { pointerId: 6, clientY: 250 });
    await wrapper.vm.$nextTick();
    expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBe(-60);
    expect(store.automationLanes).toHaveLength(0);
  });

  it('adds and removes an insert automation lane from the knob context menu', async () => {
    addInsert(trackId, 'dynamics.compressor');
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'insert', trackId, index: 0 }, positionPpq: () => 0 },
    });
    const knob = wrapper.find('[data-control="thresholdDb"]');

    // First open: the entry seeds a lane holding the current value.
    await knob.trigger('contextmenu', { clientX: 5, clientY: 5 });
    const menuButton = wrapper.find('.qc-menu button');
    expect(menuButton.exists()).toBe(true);
    await menuButton.trigger('click');
    await wrapper.vm.$nextTick();
    const param = insertAutomationParam(
      store.tracks[0].mixer?.inserts[0].id as string,
      'thresholdDb',
    );
    const lane = store.automationLanes.find((l) => l.target === trackId && l.param === param);
    expect(lane).toBeDefined();
    expect(lane?.points).toHaveLength(1);

    // Second open: the same entry removes the existing lane.
    await knob.trigger('contextmenu', { clientX: 5, clientY: 5 });
    await wrapper.find('.qc-menu button').trigger('click');
    await wrapper.vm.$nextTick();
    expect(store.automationLanes.find((l) => l.param === param)).toBeUndefined();
  });

  it('touch-records an instrument knob into an instrument lane in a write mode', async () => {
    setAutomationStripMode(trackId, 'touch');
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId }, positionPpq: () => 0, isPlaying: true },
    });
    const knob = wrapper.find('[data-control="cutoffHz"]');
    firePointer(knob, 'pointerdown', { button: 0, pointerId: 7, clientY: 200 });
    firePointer(knob, 'pointermove', { pointerId: 7, clientY: 180 });
    firePointer(knob, 'pointerup', { pointerId: 7, clientY: 180 });
    await wrapper.vm.$nextTick();

    // The drag wrote a lane; the preset instrument itself is left untouched.
    expect(store.tracks[0].instrument).toBeUndefined();
    const lane = store.automationLanes.find(
      (l) => l.target === trackId && l.param === instrumentAutomationParam('cutoffHz'),
    );
    expect(lane?.points.length).toBeGreaterThan(0);
  });

  it('adds an instrument lane holding the current value from the knob context menu', async () => {
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId }, positionPpq: () => 0 },
    });
    await wrapper
      .find('[data-control="cutoffHz"]')
      .trigger('contextmenu', { clientX: 5, clientY: 5 });
    await wrapper.find('.qc-menu button').trigger('click');
    await wrapper.vm.$nextTick();
    const lane = store.automationLanes.find(
      (l) => l.target === trackId && l.param === instrumentAutomationParam('cutoffHz'),
    );
    expect(lane?.points).toEqual([{ ppq: 0, value: 12000 }]);
  });

  it('closes the MIDI learn context menu on outside pointerdown', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper
      .find('[data-control="cutoffHz"]')
      .trigger('contextmenu', { clientX: 5, clientY: 5 });
    expect(wrapper.find('.qc-menu').exists()).toBe(true);

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.qc-menu').exists()).toBe(false);
    expect(learn.isArmedId(`instrument:${trackId}:cutoffHz`)).toBe(false);
  });

  it('removes the context-menu outside-click listener on unmount', async () => {
    const learn = useMidiLearn();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper
      .find('[data-control="cutoffHz"]')
      .trigger('contextmenu', { clientX: 5, clientY: 5 });

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('arms MIDI learn from the context menu and closes the menu', async () => {
    const learn = useMidiLearn();
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId } },
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });

    await wrapper
      .find('[data-control="cutoffHz"]')
      .trigger('contextmenu', { clientX: 5, clientY: 5 });
    const learnButton = wrapper
      .findAll('.qc-menu button')
      .find((button) => button.text().includes('MIDI'));
    await learnButton?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(learn.isArmedId(`instrument:${trackId}:cutoffHz`)).toBe(true);
    expect(wrapper.find('.qc-menu').exists()).toBe(false);
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

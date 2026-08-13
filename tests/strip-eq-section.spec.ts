import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StripEqSection from '@/components/mixer/StripEqSection.vue';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import type { ScopeFrame, ScopeListener, ScopeSource } from '@/engine/scope';
import { clearHistory, setStripEq, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { closeContextMenu, useContextMenuState } from '@/ui/menu/context-menu';
import { midiLearnEqTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripEqSection', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    closeContextMenu();
    await store.init();
    trackId = store.tracks[0].id;
  });

  function mountEq(props: Partial<InstanceType<typeof StripEqSection>['$props']> = {}) {
    return mount(StripEqSection, {
      props: { target: trackId, ...props },
      global: {
        stubs: { MixerKnob: true },
        directives: { tooltip: () => {} },
      },
    });
  }

  function makeScope(initial: ScopeFrame | null = null): {
    scope: ScopeSource;
    emit: (frame: ScopeFrame) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  } {
    let latest = initial;
    const listeners = new Set<ScopeListener>();
    const unsubscribe = vi.fn((listener: ScopeListener) => {
      listeners.delete(listener);
    });
    const scope: ScopeSource = {
      available: true,
      sampleRate: 48000,
      get latest() {
        return latest;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => unsubscribe(listener);
      },
    };
    return {
      scope,
      unsubscribe,
      emit(frame) {
        latest = frame;
        for (const listener of listeners) listener(frame);
      },
    };
  }

  function frame(bands: number[]): ScopeFrame {
    return {
      frame: 128,
      bands: new Float32Array(bands),
      points: new Float32Array(),
    };
  }

  function mountEqWithMidiLearn(learn: ReturnType<typeof useMidiLearn>) {
    return mount(StripEqSection, {
      props: { target: trackId },
      global: {
        provide: { [MIDI_LEARN_KEY as symbol]: learn },
        stubs: { MixerKnob: true },
        directives: { tooltip: () => {} },
      },
    });
  }

  it('exposes placement, phase and dynamic EQ band options', async () => {
    setStripEq(trackId, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
    });
    const wrapper = mountEq();

    await wrapper.get('.eq-band-label').trigger('click', { clientX: 12, clientY: 20 });
    const menu = useContextMenuState();
    expect(menu.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'placement:Mid',
        'placement:Side',
        'phase:LinearPhase',
        'dynamic:down',
        'dynamic:up',
      ]),
    );

    menu.items.find((item) => item.id === 'placement:Mid')?.run?.();
    menu.items.find((item) => item.id === 'phase:LinearPhase')?.run?.();
    menu.items.find((item) => item.id === 'dynamic:down')?.run?.();

    expect(store.tracks[0].mixer?.eq?.bands[0]).toMatchObject({
      placement: 'Mid',
      phase: 'LinearPhase',
      dynamic: true,
      thresholdDb: -24,
      ratio: 2,
      rangeDb: -6,
      attackMs: 10,
      releaseMs: 120,
    });

    menu.items.find((item) => item.id === 'placement:Stereo')?.run?.();
    menu.items.find((item) => item.id === 'phase:Inherit')?.run?.();
    menu.items.find((item) => item.id === 'dynamic:off')?.run?.();

    const band = store.tracks[0].mixer?.eq?.bands[0];
    expect(band?.placement).toBeUndefined();
    expect(band?.phase).toBeUndefined();
    expect(band?.dynamic).toBeUndefined();
    expect(band?.thresholdDb).toBeUndefined();
    expect(band?.rangeDb).toBeUndefined();
  });

  it('arms and clears EQ band MIDI learn targets from the band menu', async () => {
    setStripEq(trackId, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
    });
    const learn = useMidiLearn();
    const wrapper = mountEqWithMidiLearn(learn);
    const frequencyId = midiLearnEqTargetId(trackId, 0, 'frequencyHz');

    await wrapper.get('.eq-band-label').trigger('click', { clientX: 12, clientY: 20 });
    let menu = useContextMenuState();
    expect(menu.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['midi:learn:frequencyHz', 'midi:learn:gainDb', 'midi:learn:q']),
    );

    menu.items.find((item) => item.id === 'midi:learn:frequencyHz')?.run?.();
    expect(learn.isArmedId(frequencyId)).toBe(true);
    learn.handleCc({ channel: 0, controller: 38, value: 64 });
    expect(learn.bindingForId(frequencyId)).toEqual({ channel: 0, controller: 38 });

    await wrapper.get('.eq-band-label').trigger('click', { clientX: 12, clientY: 20 });
    menu = useContextMenuState();
    expect(menu.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['midi:forget:frequencyHz']),
    );
    menu.items.find((item) => item.id === 'midi:forget:frequencyHz')?.run?.();
    expect(learn.bindingForId(frequencyId)).toBeUndefined();
  });

  it('overlays the live strip spectrum behind the EQ curve', async () => {
    const { scope, emit, unsubscribe } = makeScope(frame([-90, -52, -28, -42, -80, -88, -92, -96]));
    const wrapper = mountEq({ scope });

    const initialPath = wrapper.get('.eq-spectrum').attributes('d');
    expect(initialPath).toContain('L');
    expect(initialPath).toContain('78 30');

    emit(frame([-90, -90, -90, -16, -24, -70, -92, -96]));
    await wrapper.vm.$nextTick();

    expect(wrapper.get('.eq-spectrum').attributes('d')).not.toBe(initialPath);
    wrapper.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes an in-flight band gesture when unmounted', async () => {
    setStripEq(trackId, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
    });
    clearHistory();
    const wrapper = mountEq();
    const gain = wrapper.findAllComponents({ name: 'MixerKnob' })[1];
    gain.vm.$emit('change', 6, false);
    wrapper.unmount();

    setStripEq(trackId, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 9, q: 1, enabled: true }],
    });
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.eq?.bands[0]?.gainDb).toBe(6);
  });

  it('keeps existing EQ bands when Match flat confirmation is cancelled', async () => {
    const existing = { type: 'Peak' as const, frequencyHz: 1000, gainDb: 4, q: 1, enabled: true };
    setStripEq(trackId, { enabled: true, bands: [existing] });
    const spectrum = new Array<number>(64).fill(-56);
    spectrum[2] = -30;
    spectrum[3] = -31;
    const { scope } = makeScope(frame(spectrum));
    const wrapper = mountEq({ scope });

    await wrapper.get('.eq-match').trigger('click');
    const request = dialogQueue[0];
    if (!request) throw new Error('expected Match flat confirmation');
    resolveDialog(request.id, false);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(store.tracks[0].mixer?.eq?.bands).toEqual([existing]);
  });

  it('creates corrective EQ bands from the current live spectrum', async () => {
    const spectrum = new Array(64).fill(-48);
    spectrum[1] = -30;
    spectrum[2] = -30;
    spectrum[3] = -31;
    for (let index = 20; index <= 42; index += 1) spectrum[index] = -72;
    const { scope } = makeScope(frame(spectrum));
    const wrapper = mountEq({ scope });

    await wrapper.get('.eq-match').trigger('click');

    const bands = store.tracks[0].mixer?.eq?.bands ?? [];
    expect(store.tracks[0].mixer?.eq?.enabled).toBe(true);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    expect(bands.some((band) => (band.frequencyHz ?? 0) < 1000 && (band.gainDb ?? 0) < 0)).toBe(
      true,
    );
    expect(bands.some((band) => (band.frequencyHz ?? 0) > 2500 && (band.gainDb ?? 0) > 0)).toBe(
      true,
    );
  });
});

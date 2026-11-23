import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import type { ControlSurfaceHandle } from '@/composables/useControlSurface';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useProjectStore } from '@/project/store';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import { midiLearnBankTargetId, midiLearnTransportTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/project/commands', () => ({
  setStripGain: vi.fn(),
  setStripPan: vi.fn(),
  // The binding commands mutate the store map in place (the same map the panel
  // reads), so model that here without the full command/history stack.
  setMidiCcBinding: vi.fn((id: string, binding: { channel: number; controller: number }) => {
    useProjectStore().midiCcBindings.set(id, { ...binding });
  }),
  clearMidiCcBinding: vi.fn((id: string) => {
    const map = useProjectStore().midiCcBindings;
    const had = map.has(id);
    map.delete(id);
    return had;
  }),
  clearAllMidiCcBindings: vi.fn(() => {
    useProjectStore().midiCcBindings.clear();
  }),
}));

const TRACKS = [
  { id: 1, name: 'Drums', color: '#ff0000' },
  { id: 2, name: 'Bass', color: '#00ff00' },
];

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Mounts the panel with a fresh learn handle. */
function mountPanel() {
  const learn = useMidiLearn();
  wrapper = mount(MidiLearnPanel, { attachTo: document.body, props: { learn, tracks: TRACKS } });
  return learn;
}

describe('MidiLearnPanel', () => {
  it('lists the master strip and every track with Vol and Pan controls', () => {
    mountPanel();
    const names = (wrapper as VueWrapper).findAll('.ml-name').map((n) => n.text());
    expect(names.some((n) => n.includes('Master'))).toBe(true);
    expect(names.some((n) => n.includes('Drums'))).toBe(true);
    expect(names.some((n) => n.includes('Bass'))).toBe(true);
    // Master + 2 tracks, two bind buttons each (transport rows bind separately).
    expect(
      (wrapper as VueWrapper).findAll(
        '.ml-bind:not(.ml-bind-transport):not(.ml-bind-bank):not(.ml-bind-bank-nav)',
      ),
    ).toHaveLength(6);
  });

  it('exposes every transport action as its own bindable row', async () => {
    const learn = mountPanel();
    const transportButtons = (wrapper as VueWrapper).findAll('.ml-bind-transport');
    expect(transportButtons).toHaveLength(4);

    await transportButtons[0].trigger('click');
    expect(learn.isArmedId(midiLearnTransportTargetId('play'))).toBe(true);
  });

  it('arms a target on click and shows it listening', async () => {
    const learn = mountPanel();
    const masterVol = (wrapper as VueWrapper).findAll(
      '.ml-bind:not(.ml-bind-transport):not(.ml-bind-bank):not(.ml-bind-bank-nav)',
    )[0];
    expect(masterVol.text()).toBe('learn');

    await masterVol.trigger('click');
    expect(learn.isArmed('gain', 'master')).toBe(true);
    expect(masterVol.text()).toBe('listening…');
    expect(masterVol.classes()).toContain('ml-bind-armed');
  });

  it('shows the binding after a CC arrives and clears it on demand', async () => {
    const learn = mountPanel();
    await (wrapper as VueWrapper).findAll('.ml-bind')[0].trigger('click');

    learn.handleCc({ channel: 0, controller: 7, value: 100 });
    await (wrapper as VueWrapper).vm.$nextTick();

    const masterVol = (wrapper as VueWrapper).findAll('.ml-bind')[0];
    expect(masterVol.text()).toBe('CC 7 · Ch 1');
    expect(masterVol.classes()).toContain('ml-bind-set');

    const clear = (wrapper as VueWrapper).find('.ml-clear');
    expect(clear.exists()).toBe(true);
    await clear.trigger('click');
    expect(learn.bindingFor('gain', 'master')).toBeUndefined();
  });

  it('lists insert/instrument bindings and forgets them individually', async () => {
    mountPanel();
    const store = useProjectStore();
    store.midiCcBindings.set('insert:1:0:thresholdDb', { channel: 0, controller: 20 });
    store.midiCcBindings.set('instrument:2:cutoffHz', { channel: 1, controller: 74 });
    await (wrapper as VueWrapper).vm.$nextTick();

    const rows = (wrapper as VueWrapper).findAll(
      '.ml-device-row:not(.ml-transport-row):not(.ml-bank-nav-row)',
    );
    expect(rows).toHaveLength(2);
    const devices = (wrapper as VueWrapper).find('.ml-devices:not(.ml-transport)').text();
    expect(devices).toContain('Drums · Insert 1 · Threshold Db');
    expect(devices).toContain('Bass · Instrument · Cutoff Hz');

    // Rows are sorted by label, so "Bass · Instrument…" comes first.
    await rows[0].find('.ml-clear').trigger('click');
    expect(store.midiCcBindings.has('instrument:2:cutoffHz')).toBe(false);
    expect(store.midiCcBindings.has('insert:1:0:thresholdDb')).toBe(true);
  });

  it('disables Clear all until something is bound or armed', async () => {
    const learn = mountPanel();
    const clearAll = (wrapper as VueWrapper).find('.ml-foot .ml-btn');
    expect(clearAll.attributes('disabled')).toBeDefined();

    learn.arm('pan', 2);
    await (wrapper as VueWrapper).vm.$nextTick();
    expect(clearAll.attributes('disabled')).toBeUndefined();
  });

  it('focuses itself and requests close on Escape or an outside click', async () => {
    mountPanel();
    await (wrapper as VueWrapper).vm.$nextTick();
    // The dialog takes focus, not its dismiss action, so the name is announced
    // and the first Tab reaches the bindings.
    expect(document.activeElement).toBe((wrapper as VueWrapper).find('.midi-learn-panel').element);

    const close = (wrapper as VueWrapper).find('.ml-close');
    await close.trigger('keydown', { key: 'Escape' });
    expect((wrapper as VueWrapper).emitted('close')).toHaveLength(1);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect((wrapper as VueWrapper).emitted('close')).toHaveLength(2);
  });
});

describe('MidiLearnPanel availability', () => {
  it('disables learning until a MIDI input is connected', async () => {
    const learn = useMidiLearn();
    const surface = {
      available: ref<boolean | null>(true),
      inputs: ref<Array<{ id: string; name: string }>>([]),
      outputs: ref([]),
    } as unknown as ControlSurfaceHandle;
    wrapper = mount(MidiLearnPanel, {
      attachTo: document.body,
      props: { learn, tracks: TRACKS, surface },
    });
    const bind = () => (wrapper as VueWrapper).find('.ml-bind');

    expect(bind().attributes('disabled')).toBeDefined();
    surface.inputs.value = [{ id: 'in-1', name: 'Keys' }];
    await (wrapper as VueWrapper).vm.$nextTick();
    expect(bind().attributes('disabled')).toBeUndefined();
  });
});

describe('MidiLearnPanel control surface', () => {
  it('selects the surface protocol into the project', async () => {
    mountPanel();
    const store = useProjectStore();
    const select = (wrapper as VueWrapper).find('.ml-surface select');

    await select.setValue('mcu');

    expect(store.controlSurface.protocol).toBe('mcu');
  });

  it('warns that the HUI mapping is unverified', async () => {
    mountPanel();
    const store = useProjectStore();
    expect((wrapper as VueWrapper).find('.ml-surface-warning').exists()).toBe(false);

    store.controlSurface = { ...store.controlSurface, protocol: 'hui' };
    await (wrapper as VueWrapper).vm.$nextTick();

    expect((wrapper as VueWrapper).find('.ml-surface-warning').exists()).toBe(true);
  });

  it('learns a bank slot rather than a fixed track', async () => {
    const learn = mountPanel();
    const slotButton = (wrapper as VueWrapper).findAll('.ml-bind-bank')[0];

    await slotButton.trigger('click');
    expect(learn.isArmedId(midiLearnBankTargetId(0, 'gain'))).toBe(true);

    learn.handleCc({ channel: 0, controller: 20, value: 64 });
    await (wrapper as VueWrapper).vm.$nextTick();
    expect(learn.bindingForId(midiLearnBankTargetId(0, 'gain'))).toEqual({
      channel: 0,
      controller: 20,
    });
  });

  it('shows one row per surface strip', async () => {
    mountPanel();
    const store = useProjectStore();
    expect((wrapper as VueWrapper).findAll('.ml-bank-row')).toHaveLength(8);

    store.controlSurface = { ...store.controlSurface, bankSize: 4 };
    await (wrapper as VueWrapper).vm.$nextTick();

    expect((wrapper as VueWrapper).findAll('.ml-bank-row')).toHaveLength(4);
  });

  it('clamps typed bank sizes to a valid integer strip count', async () => {
    mountPanel();
    const store = useProjectStore();
    const input = (wrapper as VueWrapper).find<HTMLInputElement>('.ml-surface-bank-size');
    for (const [typed, expected] of [
      ['20', 8],
      ['-3', 1],
      ['2.5', 3],
      ['', 3],
    ] as const) {
      await input.setValue(typed);
      expect(store.controlSurface.bankSize).toBe(expected);
    }
  });

  it('pages the bank window from the panel', async () => {
    mountPanel();
    const store = useProjectStore();
    store.tracks = [
      ...TRACKS.map((track) => ({
        ...track,
        kind: 'midi' as const,
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
      })),
    ];
    store.controlSurface = { ...store.controlSurface, bankSize: 1 };
    await (wrapper as VueWrapper).vm.$nextTick();

    const [prev, next] = (wrapper as VueWrapper).findAll('.ml-bank-step');
    await next.trigger('click');
    expect(store.controlSurface.bankOffset).toBe(1);
    await prev.trigger('click');
    expect(store.controlSurface.bankOffset).toBe(0);
  });

  it('labels the surface section in every locale', () => {
    for (const bundle of [en, ja]) {
      expect(bundle.shell.midiLearn.surface.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.surfaceProtocols.mcu.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.surfaceFeedback.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.surfaceHuiNote.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.bank.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.bankActions.next.length).toBeGreaterThan(0);
      expect(bundle.shell.midiLearn.bankParams.solo.length).toBeGreaterThan(0);
    }
  });
});

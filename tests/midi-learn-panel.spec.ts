import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useProjectStore } from '@/project/store';

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
  wrapper = mount(MidiLearnPanel, { props: { learn, tracks: TRACKS } });
  return learn;
}

describe('MidiLearnPanel', () => {
  it('lists the master strip and every track with Vol and Pan controls', () => {
    mountPanel();
    const names = (wrapper as VueWrapper).findAll('.ml-name').map((n) => n.text());
    expect(names.some((n) => n.includes('Master'))).toBe(true);
    expect(names.some((n) => n.includes('Drums'))).toBe(true);
    expect(names.some((n) => n.includes('Bass'))).toBe(true);
    // Master + 2 tracks, two bind buttons each.
    expect((wrapper as VueWrapper).findAll('.ml-bind')).toHaveLength(6);
  });

  it('arms a target on click and shows it listening', async () => {
    const learn = mountPanel();
    const masterVol = (wrapper as VueWrapper).findAll('.ml-bind')[0];
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

    const rows = (wrapper as VueWrapper).findAll('.ml-device-row');
    expect(rows).toHaveLength(2);
    const devices = (wrapper as VueWrapper).find('.ml-devices').text();
    expect(devices).toContain('Drums · Insert 1 · Threshold Db');
    expect(devices).toContain('Bass · Instrument · Cutoff Hz');

    // Rows are sorted by label, so "Bass · Instrument…" comes first.
    await rows[0].find('.ml-clear').trigger('click');
    expect(store.midiCcBindings.has('instrument:2:cutoffHz')).toBe(false);
    expect(store.midiCcBindings.has('insert:1:0:thresholdDb')).toBe(true);
  });

  it('disables Clear all until something is bound or armed', async () => {
    const learn = mountPanel();
    const clearAll = (wrapper as VueWrapper).find('.ml-btn');
    expect(clearAll.attributes('disabled')).toBeDefined();

    learn.arm('pan', 2);
    await (wrapper as VueWrapper).vm.$nextTick();
    expect(clearAll.attributes('disabled')).toBeUndefined();
  });
});

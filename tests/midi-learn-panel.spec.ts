import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import { useMidiLearn } from '@/composables/useMidiLearn';

vi.mock('@/project/commands', () => ({
  setStripGain: vi.fn(),
  setStripPan: vi.fn(),
}));

const TRACKS = [
  { id: 1, name: 'Drums', color: '#ff0000' },
  { id: 2, name: 'Bass', color: '#00ff00' },
];

let wrapper: VueWrapper | null = null;

beforeEach(() => {
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

  it('disables Clear all until something is bound or armed', async () => {
    const learn = mountPanel();
    const clearAll = (wrapper as VueWrapper).find('.ml-btn');
    expect(clearAll.attributes('disabled')).toBeDefined();

    learn.arm('pan', 2);
    await (wrapper as VueWrapper).vm.$nextTick();
    expect(clearAll.attributes('disabled')).toBeUndefined();
  });
});

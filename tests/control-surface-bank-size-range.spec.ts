import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ControlSurfaceSettings from '@/components/shell/ControlSurfaceSettings.vue';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { sanitizeControlSurfaceSettings } from '@/project/control-surface';
import { MAX_CONTROL_SURFACE_SLOTS } from '@/project/midi-learn-targets';
import { useProjectStore } from '@/project/store';

vi.mock('@/project/commands', () => ({
  setStripGain: vi.fn(),
  setStripPan: vi.fn(),
  setMidiCcBinding: vi.fn(),
  clearMidiCcBinding: vi.fn(() => false),
  clearAllMidiCcBindings: vi.fn(),
}));

const TRACKS = [{ id: 1, name: 'Drums', color: '#ff0000' }];

let wrapper: VueWrapper | null = null;

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function mountPanel(): VueWrapper {
  wrapper = mount(MidiLearnPanel, {
    attachTo: document.body,
    props: { learn: useMidiLearn(), tracks: TRACKS },
  });
  return wrapper;
}

describe('control-surface bank size range', () => {
  it('offers every strip count the settings model accepts', () => {
    const input = mountPanel().find<HTMLInputElement>('.ml-surface-bank-size');
    expect(input.attributes('max')).toBe(String(MAX_CONTROL_SURFACE_SLOTS));
  });

  it('keeps a learned-CC surface wider than one protocol bank, with a row per strip', async () => {
    const panel = mountPanel();
    await panel.find<HTMLInputElement>('.ml-surface-bank-size').setValue('16');
    expect(useProjectStore().controlSurface.bankSize).toBe(16);
    expect(panel.findAll('.ml-bank-row')).toHaveLength(16);
  });

  it('narrows the width to the strips a protocol surface addresses when one is chosen', async () => {
    const panel = mountPanel();
    const settings = panel.findComponent(ControlSurfaceSettings);
    await settings.find<HTMLInputElement>('.ml-surface-bank-size').setValue('16');
    await settings.find<HTMLSelectElement>('select.ml-select').setValue('mcu');
    expect(useProjectStore().controlSurface.bankSize).toBe(8);
    expect(settings.find('.ml-surface-bank-size').attributes('max')).toBe('8');
    expect(panel.findAll('.ml-bank-row')).toHaveLength(8);
  });

  it('caps a stored protocol surface at its strips when settings are read', () => {
    expect(sanitizeControlSurfaceSettings({ protocol: 'mcu', bankSize: 16 }).bankSize).toBe(8);
    expect(sanitizeControlSurfaceSettings({ protocol: 'hui', bankSize: 32 }).bankSize).toBe(8);
    expect(sanitizeControlSurfaceSettings({ protocol: 'none', bankSize: 32 }).bankSize).toBe(32);
  });
});

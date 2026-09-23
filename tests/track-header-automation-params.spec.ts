import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { instrumentAutomationParam } from '@/project/automation';
import { clearHistory, setTrackInstrument } from '@/project/commands';
import { AUTOMATABLE_SYNTH_PARAMS } from '@/project/instrument';
import { useProjectStore } from '@/project/store';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Automation lane-picker options of the first track's expanded header. */
function laneOptions(): Array<{ value: string; label: string }> {
  const store = useProjectStore();
  const trackId = store.tracks[0].id;
  const headers = mount(TrackHeaderList, {
    props: {
      laneHeight: 48,
      scrollY: 0,
      rulerOffset: 24,
      rowLayout: buildRowLayout(
        store.tracks.map((track) => track.id === trackId),
        48,
      ),
      automationExpandedIds: [trackId],
    },
  });
  const strip = headers
    .findAllComponents({ name: 'TrackAutomationStrip' })
    .find((entry) => entry.props('track').id === trackId);
  return strip?.props('options') ?? [];
}

describe('TrackHeaderList automation lane picker', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('offers every automatable synth field on a NativeSynth MIDI track', () => {
    const values = laneOptions().map((option) => option.value);
    for (const param of AUTOMATABLE_SYNTH_PARAMS) {
      expect(values).toContain(instrumentAutomationParam(param));
    }
  });

  it('labels a synth field with its editor section so envelopes stay distinct', () => {
    const labels = new Map(laneOptions().map((option) => [option.value, option.label]));
    expect(labels.get(instrumentAutomationParam('ampAttackMs'))).toBe('Amp envelope · Attack');
    expect(labels.get(instrumentAutomationParam('filterAttackMs'))).toBe(
      'Filter envelope · Attack',
    );
  });

  it('offers no synth fields for an SF2 instrument', () => {
    const store = useProjectStore();
    setTrackInstrument(store.tracks[0].id, { kind: 'sf2', fontId: 'gm' });
    expect(laneOptions().some((option) => option.value.startsWith('instrument:'))).toBe(false);
  });
});

import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArrangementAnalysisPanel from '@/components/arrangement/ArrangementAnalysisPanel.vue';
import { addMidiClip, addNote, addTrack, clearHistory, setActiveClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/**
 * Seeds a small project: a held C-major triad on the default track, a Lead
 * track sustaining a clashing C#, and an empty Drums track that the analysis
 * must exclude as percussion.
 */
function seedProject(): void {
  for (const pitch of [60, 64, 67]) {
    addNote({ pitch, startPpq: 0, durationPpq: 4 });
  }
  const leadTrackId = addTrack({ name: 'Lead' });
  const leadClipId = addMidiClip({ trackId: leadTrackId, startPpq: 0, lengthPpq: 8 });
  setActiveClip(leadClipId);
  addNote({ pitch: 61, startPpq: 0, durationPpq: 4 });
  addTrack({ name: 'Drums' });
}

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('ArrangementAnalysisPanel', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('starts collapsed and shows the run prompt before the first analysis', async () => {
    wrapper = mount(ArrangementAnalysisPanel);
    expect(wrapper.find('.ap-body').exists()).toBe(false);

    await wrapper.find('.ap-toggle').trigger('click');
    expect(wrapper.find('.ap-prompt').exists()).toBe(true);
    expect(wrapper.findAll('.ap-row')).toHaveLength(0);
  });

  it('populates conflicts and the excluded-percussion note on Analyze', async () => {
    seedProject();
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    // The drum track shows up in the excluded note, never as a conflict row.
    expect(wrapper.find('.ap-excluded').text()).toContain('Drums');
    const rows = wrapper.findAll('.ap-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text()).not.toContain('Drums');
    }
    expect(wrapper.find('.ap-prompt').exists()).toBe(false);
    expect(wrapper.find('.ap-spark').exists()).toBe(true);
  });
});

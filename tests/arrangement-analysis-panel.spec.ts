import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArrangementAnalysisPanel from '@/components/arrangement/ArrangementAnalysisPanel.vue';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  setActiveClip,
  setProjectChords,
} from '@/project/commands';
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
    expect(wrapper.find('.ap-popover').exists()).toBe(false);

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

  /**
   * Four four-bar units of a I-IV-V-I turn, each closing on a held tonic, with
   * the progression written to the chord track so the phrasing reads the stated
   * harmony rather than an inferred one.
   */
  function seedPeriodicPiece(): void {
    const clipId = addMidiClip({ trackId: store.tracks[0].id, startPpq: 0, lengthPpq: 64 });
    setActiveClip(clipId);
    const chords = [];
    for (let unit = 0; unit < 4; unit += 1) {
      const at = unit * 16;
      addNote({ pitch: 60, startPpq: at, durationPpq: 1 });
      addNote({ pitch: 64, startPpq: at + 1, durationPpq: 1 });
      addNote({ pitch: 67, startPpq: at + 2, durationPpq: 1 });
      addNote({ pitch: 72, startPpq: at + 3, durationPpq: 1 });
      addNote({ pitch: 65, startPpq: at + 4, durationPpq: 1 });
      addNote({ pitch: 69, startPpq: at + 5, durationPpq: 1 });
      addNote({ pitch: 72, startPpq: at + 6, durationPpq: 1 });
      addNote({ pitch: 69, startPpq: at + 7, durationPpq: 1 });
      addNote({ pitch: 67, startPpq: at + 8, durationPpq: 1 });
      addNote({ pitch: 71, startPpq: at + 9, durationPpq: 1 });
      addNote({ pitch: 74, startPpq: at + 10, durationPpq: 1 });
      addNote({ pitch: 71, startPpq: at + 11, durationPpq: 1 });
      addNote({ pitch: 60, startPpq: at + 12, durationPpq: 4 });
      chords.push(
        { startPpq: at, endPpq: at + 4, rootPc: 0, quality: 0 },
        { startPpq: at + 4, endPpq: at + 8, rootPc: 5, quality: 0 },
        { startPpq: at + 8, endPpq: at + 12, rootPc: 7, quality: 4 },
        { startPpq: at + 12, endPpq: at + 16, rootPc: 0, quality: 0 },
      );
    }
    setProjectChords(chords);
  }

  it('reports the phrase structure alongside the conflicts', async () => {
    seedPeriodicPiece();
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    const summary = wrapper.find('.ap-structure');
    expect(summary.exists()).toBe(true);
    // Phrase count and hyperbar length both appear, as digits.
    expect(summary.text()).toMatch(/\d/);
  });

  it('jumps to a cadence when its row is clicked', async () => {
    seedPeriodicPiece();
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    const rows = wrapper.findAll('.ap-cadence-row');
    expect(rows.length).toBeGreaterThan(0);
    await rows[0].trigger('click');
    expect(wrapper.emitted('jump')?.length).toBeGreaterThan(0);
  });
});

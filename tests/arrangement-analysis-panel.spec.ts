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
import { MESSAGES } from '@/ui/i18n';

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

/**
 * Every phrase the panel can write for one field, across all locales.
 *
 * The analyzer states its readings in English prose. Pinning each row's text to
 * the message trees is what catches that prose being rendered straight into a
 * localized UI: the library's wording is not in any tree, so it fails here
 * rather than reaching a reader.
 */
function localizedTexts(field: 'conflictReason' | 'motifShape' | 'motifRelation'): string[] {
  return Object.values(MESSAGES).flatMap((tree) =>
    Object.values(tree.shell.arrangementAnalysis[field]),
  );
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

  // A restated figure is the one reading the panel can offer that a list of
  // conflicts cannot: it says the piece has a shape, not just clashes.
  it('lists a restated figure and jumps to its first statement', async () => {
    const leadTrackId = addTrack({ name: 'Lead' });
    const leadClipId = addMidiClip({ trackId: leadTrackId, startPpq: 0, lengthPpq: 32 });
    setActiveClip(leadClipId);
    for (let statement = 0; statement < 3; statement += 1) {
      [0, 2, 4, 2].forEach((degree, index) => {
        addNote({
          pitch: 60 + statement * 2 + degree,
          startPpq: statement * 4 + index,
          durationPpq: 1,
        });
      });
    }
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    const rows = wrapper.findAll('.ap-motif-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(wrapper.find('.ap-motif-track').text()).toContain('Lead');
    await rows[0].trigger('click');
    expect(wrapper.emitted('jump')?.[0]).toEqual([0]);
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

  it('writes every conflict reason from the message tree, never the analyzer prose', async () => {
    seedProject();
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    const reasons = localizedTexts('conflictReason');
    const written = wrapper
      .findAll('.ap-row')
      .map((row) => row.find('.ap-rationale'))
      .filter((cell) => cell.exists());
    expect(written.length).toBeGreaterThan(0);
    for (const cell of written) expect(reasons).toContain(cell.text());
  });

  it('writes a figure as its shape and a relation as its name', async () => {
    const leadTrackId = addTrack({ name: 'Lead' });
    const leadClipId = addMidiClip({ trackId: leadTrackId, startPpq: 0, lengthPpq: 32 });
    setActiveClip(leadClipId);
    for (let statement = 0; statement < 3; statement += 1) {
      [0, 2, 4, 2].forEach((degree, index) => {
        addNote({
          pitch: 60 + statement * 2 + degree,
          startPpq: statement * 4 + index,
          durationPpq: 1,
        });
      });
    }
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    // A row reads "<shape>" or "<shape> · <moved in pitch>"; both halves are
    // message-tree text, so a raw rationale cannot pass either check.
    const shapes = localizedTexts('motifShape');
    const moved = Object.values(MESSAGES).map(
      (tree) => tree.shell.arrangementAnalysis.motifTransposed,
    );
    const rows = wrapper.findAll('.ap-motif-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [shape, qualifier] = row.find('.ap-rationale').text().split(' · ');
      expect(shapes).toContain(shape);
      if (qualifier !== undefined) expect(moved).toContain(qualifier);
    }

    const kinds = localizedTexts('motifRelation');
    const sequences = Object.values(MESSAGES).map(
      (tree) => tree.shell.arrangementAnalysis.motifSequence,
    );
    for (const relation of wrapper.findAll('.ap-relation')) {
      const [kind, qualifier] = relation.text().split(' · ');
      expect(kinds).toContain(kind);
      if (qualifier !== undefined) expect(sequences).toContain(qualifier);
    }
  });

  it('writes a cadence confidence from the message tree template', async () => {
    seedPeriodicPiece();
    wrapper = mount(ArrangementAnalysisPanel);
    await wrapper.find('.ap-toggle').trigger('click');
    await wrapper.find('.ap-analyze').trigger('click');

    const patterns = Object.values(MESSAGES).map(
      (tree) =>
        new RegExp(
          `^${tree.shell.arrangementAnalysis.cadenceConfidence.replace('{percent}', '\\d+')}$`,
        ),
    );
    const rows = wrapper.findAll('.ap-cadence-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = row.find('.ap-rationale').text();
      expect(patterns.some((pattern) => pattern.test(text))).toBe(true);
    }
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

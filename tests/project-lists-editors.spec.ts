import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkerListEditor from '@/components/lists/MarkerListEditor.vue';
import ProjectListsPanel from '@/components/lists/ProjectListsPanel.vue';
import TempoMapEditor from '@/components/lists/TempoMapEditor.vue';
import TimeSignatureEditor from '@/components/lists/TimeSignatureEditor.vue';
import { canUndo, clearHistory, redo, setMarker, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Finds a button by its exact trimmed text. */
function buttonByText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((b) => b.text() === text);
  if (!button) throw new Error(`Button "${text}" not found`);
  return button;
}

describe('project list editors', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  describe('TempoMapEditor', () => {
    it('shows one row per tempo segment from the store', () => {
      const wrapper = mount(TempoMapEditor);
      const rows = wrapper.findAll('tbody tr');
      expect(rows).toHaveLength(1);
      expect((rows[0].findAll('input')[0].element as HTMLInputElement).value).toBe('1.1');
      expect((rows[0].findAll('input')[1].element as HTMLInputElement).value).toBe('120');
      wrapper.unmount();
    });

    it('adds a row and commits the map as one undoable edit on Apply', async () => {
      const wrapper = mount(TempoMapEditor);
      await buttonByText(wrapper, 'Add tempo').trigger('click');
      const rows = wrapper.findAll('tbody tr');
      expect(rows).toHaveLength(2);
      // The new row defaults to the next bar with the inherited tempo.
      expect((rows[1].findAll('input')[0].element as HTMLInputElement).value).toBe('2.1');
      await rows[1].findAll('input')[1].setValue('140');
      await buttonByText(wrapper, 'Apply').trigger('click');

      expect(store.tempoSegments).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 140 },
      ]);
      expect(canUndo()).toBe(true);
      expect(undo()).toBe(true);
      expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
      expect(redo()).toBe(true);
      expect(store.tempoSegments).toHaveLength(2);
      wrapper.unmount();
    });

    it('resyncs the clean draft after undo', async () => {
      const wrapper = mount(TempoMapEditor);
      await buttonByText(wrapper, 'Add tempo').trigger('click');
      await wrapper.findAll('tbody tr')[1].findAll('input')[1].setValue('140');
      await buttonByText(wrapper, 'Apply').trigger('click');
      undo();
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('tbody tr')).toHaveLength(1);
      wrapper.unmount();
    });

    it('rejects an out-of-range BPM without touching the store', async () => {
      const wrapper = mount(TempoMapEditor);
      await wrapper.find('tbody input[type="number"]').setValue('10');
      await buttonByText(wrapper, 'Apply').trigger('click');
      expect(wrapper.find('.list-error').text()).toContain('BPM must be between 20 and 400');
      expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
      expect(canUndo()).toBe(false);
      wrapper.unmount();
    });

    it('rejects an unparseable position', async () => {
      const wrapper = mount(TempoMapEditor);
      await wrapper.find('tbody input[type="text"]').setValue('nope');
      await buttonByText(wrapper, 'Apply').trigger('click');
      expect(wrapper.find('.list-error').text()).toContain('invalid position');
      expect(canUndo()).toBe(false);
      wrapper.unmount();
    });

    it('reverts the draft to the store state', async () => {
      const wrapper = mount(TempoMapEditor);
      await buttonByText(wrapper, 'Add tempo').trigger('click');
      expect(wrapper.findAll('tbody tr')).toHaveLength(2);
      await buttonByText(wrapper, 'Revert').trigger('click');
      expect(wrapper.findAll('tbody tr')).toHaveLength(1);
      expect(canUndo()).toBe(false);
      wrapper.unmount();
    });
  });

  describe('TimeSignatureEditor', () => {
    it('commits added meter changes as one undoable edit', async () => {
      const wrapper = mount(TimeSignatureEditor);
      // A fresh project carries no explicit meter entries.
      expect(wrapper.findAll('tbody tr')).toHaveLength(0);
      await buttonByText(wrapper, 'Add meter').trigger('click'); // 1.1, 4/4
      await buttonByText(wrapper, 'Add meter').trigger('click'); // 2.1, 4/4
      const row = wrapper.findAll('tbody tr')[1];
      await row.find('input[type="number"]').setValue('6');
      await row.find('select').setValue('8');
      await buttonByText(wrapper, 'Apply').trigger('click');

      expect(store.timeSignatures).toEqual([
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 6, denominator: 8 },
      ]);
      expect(undo()).toBe(true);
      expect(store.timeSignatures).toEqual([]);
      wrapper.unmount();
    });

    it('drops a row restating the current meter on Apply', async () => {
      const wrapper = mount(TimeSignatureEditor);
      await buttonByText(wrapper, 'Add meter').trigger('click');
      await buttonByText(wrapper, 'Apply').trigger('click');
      // The added row inherits 4/4, so the merge keeps a single segment.
      expect(store.timeSignatures).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
      wrapper.unmount();
    });
  });

  describe('MarkerListEditor', () => {
    it('adds a marker at the playhead', async () => {
      const wrapper = mount(MarkerListEditor, { props: { positionPpq: () => 6 } });
      await buttonByText(wrapper, 'Add at playhead').trigger('click');
      expect(store.markers).toHaveLength(1);
      expect(store.markers[0].ppq).toBe(6);
      expect(store.markers[0].name).toBe('Marker 1');
      // The new row shows the bars.beats position (PPQ 6 = bar 2, beat 3).
      expect((wrapper.find('tbody input').element as HTMLInputElement).value).toBe('2.3');
      wrapper.unmount();
    });

    it('emits seek when a row is clicked', async () => {
      setMarker(null, 8, 'Chorus');
      const wrapper = mount(MarkerListEditor);
      await wrapper.find('tbody tr').trigger('click');
      expect(wrapper.emitted('seek')).toEqual([[8]]);
      wrapper.unmount();
    });

    it('commits an edited position and re-sorts the list', async () => {
      setMarker(null, 0, 'Intro');
      setMarker(null, 8, 'Chorus');
      const wrapper = mount(MarkerListEditor);
      const positionInput = wrapper.findAll('tbody tr')[0].findAll('input')[0];
      // setValue triggers both input and change; change commits the edit.
      await positionInput.setValue('4.1');
      expect(store.markers.map((m) => [m.ppq, m.name])).toEqual([
        [8, 'Chorus'],
        [12, 'Intro'],
      ]);
      wrapper.unmount();
    });

    it('rejects an invalid position and keeps the marker unchanged', async () => {
      setMarker(null, 8, 'Chorus');
      const wrapper = mount(MarkerListEditor);
      const positionInput = wrapper.find('tbody input');
      await positionInput.setValue('garbage');
      expect(wrapper.find('.list-error').text()).toContain('Invalid position');
      expect(store.markers[0].ppq).toBe(8);
      expect((positionInput.element as HTMLInputElement).value).toBe('3.1');
      wrapper.unmount();
    });

    it('renames and deletes markers', async () => {
      setMarker(null, 8, 'Chorus');
      const wrapper = mount(MarkerListEditor);
      const nameInput = wrapper.findAll('tbody tr')[0].findAll('input')[1];
      await nameInput.setValue('Drop');
      expect(store.markers[0].name).toBe('Drop');

      await wrapper.find('button[aria-label="Delete marker Drop"]').trigger('click');
      expect(store.markers).toHaveLength(0);
      expect(wrapper.emitted('seek')).toBeUndefined();
      wrapper.unmount();
    });
  });

  describe('ProjectListsPanel', () => {
    it('shows the tempo tab by default and switches tabs', async () => {
      const wrapper = mount(ProjectListsPanel);
      expect(wrapper.findComponent(TempoMapEditor).exists()).toBe(true);
      await buttonByText(wrapper, 'Time Sig').trigger('click');
      expect(wrapper.findComponent(TimeSignatureEditor).exists()).toBe(true);
      await buttonByText(wrapper, 'Markers').trigger('click');
      expect(wrapper.findComponent(MarkerListEditor).exists()).toBe(true);
      wrapper.unmount();
    });

    it('forwards the playhead getter and seek events for markers', async () => {
      const wrapper = mount(ProjectListsPanel, { props: { positionPpq: () => 4 } });
      await buttonByText(wrapper, 'Markers').trigger('click');
      await buttonByText(wrapper, 'Add at playhead').trigger('click');
      expect(store.markers[0].ppq).toBe(4);
      await wrapper.find('tbody tr').trigger('click');
      expect(wrapper.emitted('seek')).toEqual([[4]]);
      wrapper.unmount();
    });
  });
});

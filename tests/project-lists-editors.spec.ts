import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChordListEditor from '@/components/lists/ChordListEditor.vue';
import KeyListEditor from '@/components/lists/KeyListEditor.vue';
import MarkerListEditor from '@/components/lists/MarkerListEditor.vue';
import ProjectListsPanel from '@/components/lists/ProjectListsPanel.vue';
import TempoMapEditor from '@/components/lists/TempoMapEditor.vue';
import TimeSignatureEditor from '@/components/lists/TimeSignatureEditor.vue';
import {
  addNote,
  canUndo,
  clearHistory,
  redo,
  setMarker,
  setProjectChords,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { vTooltip } from '@/ui/tooltip';
import { chooseOption, selectOption } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const audioTempoMock = vi.hoisted(() => ({
  detectActiveAudioClipTempo: vi.fn(),
  detectActiveAudioClipTempoMap: vi.fn(),
  detectActiveAudioClipTimeSignatures: vi.fn(),
}));
vi.mock('@/project/audio-tempo', () => audioTempoMock);

/** Finds a button by its exact trimmed text. */
function buttonByText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((b) => b.text() === text);
  if (!button) throw new Error(`Button "${text}" not found`);
  return button;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function audioClip(id: number, assetId = `asset-${id}`) {
  return {
    id,
    kind: 'audio',
    assetId,
    lengthPpq: 8,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    trackId: 1,
    startPpq: 0,
  };
}

describe('project list editors', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
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

    it('ignores a stale clip tempo detection after the active clip changes', async () => {
      const pending = deferred<number | null>();
      audioTempoMock.detectActiveAudioClipTempo.mockReturnValueOnce(pending.promise);
      store.tracks = [{ ...store.tracks[0], id: 1 }];
      store.clips = [audioClip(7), audioClip(8, 'asset-2')];
      store.clipId = 7;
      const wrapper = mount(TempoMapEditor);

      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      store.clipId = 8;
      pending.resolve(144);
      await flushPromises();

      expect(audioTempoMock.detectActiveAudioClipTempo).toHaveBeenCalledWith(
        7,
        expect.any(AbortSignal),
      );
      expect(
        (wrapper.findAll('tbody tr')[0].findAll('input')[1].element as HTMLInputElement).value,
      ).toBe('120');
      wrapper.unmount();
    });

    it('aborts a running detection on unmount and applies nothing', async () => {
      const pending = deferred<number | null>();
      audioTempoMock.detectActiveAudioClipTempo.mockReturnValueOnce(pending.promise);
      store.tracks = [{ ...store.tracks[0], id: 1 }];
      store.clips = [audioClip(7)];
      store.clipId = 7;
      const wrapper = mount(TempoMapEditor);

      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      const signal = audioTempoMock.detectActiveAudioClipTempo.mock.calls[0][1] as AbortSignal;
      expect(signal.aborted).toBe(false);
      wrapper.unmount();

      expect(signal.aborted).toBe(true);
    });

    it('aborts the detection when the active clip changes and shows no error', async () => {
      const pending = deferred<number | null>();
      audioTempoMock.detectActiveAudioClipTempo.mockImplementationOnce(
        (_id: number, signal: AbortSignal) => {
          signal.addEventListener('abort', () => pending.reject(new Error('aborted')));
          return pending.promise;
        },
      );
      store.tracks = [{ ...store.tracks[0], id: 1 }];
      store.clips = [audioClip(7), audioClip(8, 'asset-2')];
      store.clipId = 7;
      const wrapper = mount(TempoMapEditor);

      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      store.clipId = 8;
      await flushPromises();

      expect(wrapper.find('[role="alert"], .list-errors, .list-error').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('aborted');
      wrapper.unmount();
    });
  });

  describe('ProjectListsPanel drafts', () => {
    it('keeps an uncommitted editor draft while switching list tabs', async () => {
      const wrapper = mount(ProjectListsPanel);
      const tempo = wrapper.findComponent(TempoMapEditor);
      await buttonByText(tempo, 'Add tempo').trigger('click');
      expect(tempo.findAll('tbody tr')).toHaveLength(2);

      await wrapper.get('[data-tab-id="meter"]').trigger('click');
      await wrapper.get('[data-tab-id="tempo"]').trigger('click');

      expect(tempo.findAll('tbody tr')).toHaveLength(2);
      expect(store.tempoSegments).toHaveLength(1);
      wrapper.unmount();
    });
  });

  describe('KeyListEditor', () => {
    it('shows and toggles the scale highlight control', async () => {
      const wrapper = mount(KeyListEditor);
      const toggle = wrapper.get('button[aria-label="Highlight the key in the piano roll"]');

      expect(toggle.text()).toBe('Highlight');
      expect(wrapper.text()).toContain('Score key changes');
      expect(wrapper.text()).not.toContain('not supported');
      expect(toggle.attributes('aria-pressed')).toBe('true');
      await toggle.trigger('click');

      expect(store.scaleHighlight.enabled).toBe(false);
      expect(toggle.attributes('aria-pressed')).toBe('false');
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
      // The denominator is a SelectMenu; open the second row's picker (index 1)
      // and pick the eighth-note unit by its visible label.
      await selectOption(row as unknown as VueWrapper, '.cell-input', '8');
      await wrapper.vm.$nextTick();
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

    it('edits and preserves additive beat grouping through undo and refresh', async () => {
      const wrapper = mount(TimeSignatureEditor);
      await buttonByText(wrapper, 'Add meter').trigger('click');
      const row = wrapper.find('tbody tr');
      await row.find('input[type="number"]').setValue('7');
      await selectOption(row as unknown as VueWrapper, '.cell-input', '8');
      await row.find('.cell-grouping').setValue('2+2+3');
      await buttonByText(wrapper, 'Apply').trigger('click');

      expect(store.timeSignatures).toEqual([
        { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      ]);
      expect(undo()).toBe(true);
      expect(store.timeSignatures).toEqual([]);
      expect(redo()).toBe(true);
      expect(store.timeSignatures).toEqual([
        { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      ]);
      wrapper.unmount();
    });

    it('ignores a stale meter detection after the active clip changes', async () => {
      const pending =
        deferred<Array<{ startPpq: number; numerator: number; denominator: number }>>();
      audioTempoMock.detectActiveAudioClipTimeSignatures.mockReturnValueOnce(pending.promise);
      store.tracks = [{ ...store.tracks[0], id: 1 }];
      store.clips = [audioClip(7), audioClip(8, 'asset-2')];
      store.clipId = 7;
      const wrapper = mount(TimeSignatureEditor);

      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      store.clipId = 8;
      pending.resolve([{ startPpq: 0, numerator: 3, denominator: 4 }]);
      await flushPromises();

      expect(audioTempoMock.detectActiveAudioClipTimeSignatures).toHaveBeenCalledWith(
        7,
        { maxNumerator: 32 },
        expect.any(AbortSignal),
      );
      expect(wrapper.findAll('tbody tr')).toHaveLength(0);
      wrapper.unmount();
    });

    it('aborts a running meter detection on unmount', async () => {
      const pending = deferred<never[]>();
      audioTempoMock.detectActiveAudioClipTimeSignatures.mockReturnValueOnce(pending.promise);
      store.tracks = [{ ...store.tracks[0], id: 1 }];
      store.clips = [audioClip(7)];
      store.clipId = 7;
      const wrapper = mount(TimeSignatureEditor);

      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      const signal = audioTempoMock.detectActiveAudioClipTimeSignatures.mock
        .calls[0][2] as AbortSignal;
      expect(signal.aborted).toBe(false);
      wrapper.unmount();

      expect(signal.aborted).toBe(true);
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

  describe('ChordListEditor', () => {
    it('adds a one-bar major chord at the playhead', async () => {
      const wrapper = mount(ChordListEditor, { props: { positionPpq: () => 4 } });
      await buttonByText(wrapper, 'Add at playhead').trigger('click');
      expect(store.chords).toEqual([{ startPpq: 4, endPpq: 8, rootPc: 0, quality: 0 }]);
      // Position shows bars.beats (PPQ 4 = bar 2) and the formatted name.
      expect((wrapper.find('.cell-position').element as HTMLInputElement).value).toBe('2.1');
      expect(wrapper.find('.cell-name').text()).toBe('C');
      wrapper.unmount();
    });

    it('edits the root, quality, and slash bass through the pickers', async () => {
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      const wrapper = mount(ChordListEditor);
      // Root / quality / bass share the `.cell-select` class within the row, so
      // disambiguate by column index: open the nth trigger, then pick by label.
      const triggers = () => wrapper.findAll('tbody tr')[0].findAll('.cell-select .select-trigger');
      await triggers()[0].trigger('click'); // root picker
      await flushPromises();
      await chooseOption('G');
      expect(store.chords[0].rootPc).toBe(7);
      await triggers()[1].trigger('click'); // quality picker
      await flushPromises();
      await chooseOption('Dominant 7');
      expect(store.chords[0].quality).toBe(4);
      await triggers()[2].trigger('click'); // slash-bass picker
      await flushPromises();
      await chooseOption('C');
      expect(store.chords[0].bassPc).toBe(0);
      expect(wrapper.find('.cell-name').text()).toBe('G7/C');
      wrapper.unmount();
    });

    it('offers extended and altered chord vocabularies for manual entry', async () => {
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      const wrapper = mount(ChordListEditor);
      const qualityTrigger = wrapper
        .findAll('tbody tr')[0]
        .findAll('.cell-select .select-trigger')[1];
      await qualityTrigger.trigger('click');
      await flushPromises();
      await chooseOption('Dominant 13');
      expect(store.chords[0]).toMatchObject({ quality: 4, extensions: [2, 9] });
      expect(wrapper.find('.cell-name').text()).toBe('C13');
      wrapper.unmount();
    });

    // A power chord shares the major ordinal and differs only by the third it
    // drops, so picking it has to carry the omission all the way through the
    // command and back out of the Project read-back.
    it('offers chords that leave an intrinsic tone out', async () => {
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      const wrapper = mount(ChordListEditor);
      const qualityTrigger = wrapper
        .findAll('tbody tr')[0]
        .findAll('.cell-select .select-trigger')[1];
      await qualityTrigger.trigger('click');
      await flushPromises();
      await chooseOption('Power chord');
      expect(store.chords[0]).toMatchObject({ quality: 0, omissions: [4] });
      expect(store.chords[0].extensions).toBeUndefined();
      expect(wrapper.find('.cell-name').text()).toBe('C5');
      wrapper.unmount();
    });

    it('detects chords from the active MIDI clip', async () => {
      addNote({ pitch: 60, startPpq: 0, durationPpq: 4 });
      addNote({ pitch: 64, startPpq: 0, durationPpq: 4 });
      addNote({ pitch: 67, startPpq: 0, durationPpq: 4 });
      const wrapper = mount(ChordListEditor);
      await buttonByText(wrapper, 'Detect from clip').trigger('click');
      expect(store.chords.length).toBeGreaterThan(0);
      expect(store.chords[0]).toMatchObject({ rootPc: 0, quality: 0 });
      wrapper.unmount();
    });

    it('deletes a chord and clears the whole track', async () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
      ]);
      const wrapper = mount(ChordListEditor);
      await wrapper.find('button[aria-label="Delete chord C"]').trigger('click');
      expect(store.chords.map((c) => c.rootPc)).toEqual([7]);
      await buttonByText(wrapper, 'Clear').trigger('click');
      expect(store.chords).toEqual([]);
      wrapper.unmount();
    });

    it('emits seek when a chord row arrow is clicked', async () => {
      setProjectChords([{ startPpq: 8, endPpq: 12, rootPc: 0, quality: 0 }]);
      const wrapper = mount(ChordListEditor);
      await wrapper.find('.cell-seek .row-button').trigger('click');
      expect(wrapper.emitted('seek')).toEqual([[8]]);
      wrapper.unmount();
    });

    it('selects a contiguous range via checkbox shift-click', async () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 8, rootPc: 5, quality: 0 },
        { startPpq: 8, endPpq: 12, rootPc: 7, quality: 0 },
      ]);
      const wrapper = mount(ChordListEditor);
      const checkboxes = () => wrapper.findAll('.cell-checkbox input');
      await checkboxes()[0].trigger('click');
      await checkboxes()[2].trigger('click', { shiftKey: true });
      expect(wrapper.find('.selection-summary').text()).toContain('3 selected');
      expect(checkboxes()[1].element.checked).toBe(true);
      wrapper.unmount();
    });

    it('selects a whole detected pattern from the group header', async () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 8, rootPc: 5, quality: 0 },
        { startPpq: 8, endPpq: 12, rootPc: 0, quality: 0 },
        { startPpq: 12, endPpq: 16, rootPc: 5, quality: 0 },
      ]);
      const wrapper = mount(ChordListEditor);
      await buttonByText(wrapper, 'Select this pattern').trigger('click');
      expect(wrapper.find('.selection-summary').text()).toContain('4 selected');
      wrapper.unmount();
    });

    it('regenerates the selected range and clears the selection afterward', async () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 8, rootPc: 5, quality: 0 },
        { startPpq: 8, endPpq: 12, rootPc: 7, quality: 0 },
      ]);
      const wrapper = mount(ChordListEditor);
      const checkboxes = () => wrapper.findAll('.cell-checkbox input');
      // Select only the middle chord (bar 2, PPQ 4-8).
      await checkboxes()[1].trigger('click');
      expect(wrapper.find('.selection-toolbar').exists()).toBe(true);

      await buttonByText(wrapper, 'Apply to selection').trigger('click');

      // Chords outside the selected range survive unchanged.
      expect(store.chords[0]).toMatchObject({ startPpq: 0, endPpq: 4, rootPc: 0 });
      expect(store.chords[store.chords.length - 1]).toMatchObject({
        startPpq: 8,
        endPpq: 12,
        rootPc: 7,
      });
      // The selection clears after applying.
      expect(wrapper.find('.selection-toolbar').exists()).toBe(false);
      wrapper.unmount();
    });
  });

  describe('unavailable actions', () => {
    const global = { directives: { tooltip: vTooltip } };

    it('names the missing audio clip and the clean draft on the tempo footer', () => {
      const wrapper = mount(TempoMapEditor, { global });
      const detect = buttonByText(wrapper, 'Detect from clip');
      expect(detect.attributes('disabled')).toBeDefined();
      expect(detect.attributes('aria-description')).toContain(
        'Select an audio clip in the arrangement first.',
      );
      const apply = buttonByText(wrapper, 'Apply');
      expect(apply.attributes('disabled')).toBeDefined();
      expect(apply.attributes('aria-description')).toContain('No unapplied edits.');
      wrapper.unmount();
    });

    it('gates odd meters on the meter detection it configures', () => {
      const wrapper = mount(TimeSignatureEditor, { global });
      const odd = wrapper.find('.option-check');
      expect(odd.find('input').attributes('disabled')).toBeDefined();
      expect(odd.attributes('aria-description')).toContain(
        'Select an audio clip in the arrangement first.',
      );
      wrapper.unmount();
    });

    it('explains an empty Clear and a reharmonize palette without the key highlight', async () => {
      const empty = mount(ChordListEditor, { global });
      const clear = buttonByText(empty, 'Clear');
      expect(clear.attributes('disabled')).toBeDefined();
      expect(clear.attributes('aria-description')).toContain('There are no chords to clear.');
      empty.unmount();

      store.scaleHighlight = { ...store.scaleHighlight, enabled: false };
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      const wrapper = mount(ChordListEditor, { global });
      const reharm = wrapper.find('button[aria-label="Reharmonize chord C"]');
      expect(reharm.attributes('disabled')).toBeDefined();
      expect(reharm.attributes('aria-description')).toContain('Turn on Highlight in the Key tab');
      wrapper.unmount();
    });
  });

  describe('ProjectListsPanel', () => {
    it('shows the tempo tab by default and switches tabs', async () => {
      const wrapper = mount(ProjectListsPanel);
      expect(wrapper.findComponent(TempoMapEditor).exists()).toBe(true);
      await buttonByText(wrapper, 'Time Sig').trigger('click');
      expect(wrapper.findComponent(TimeSignatureEditor).exists()).toBe(true);
      await buttonByText(wrapper, 'Chords').trigger('click');
      expect(wrapper.findComponent(ChordListEditor).exists()).toBe(true);
      await buttonByText(wrapper, 'Markers').trigger('click');
      expect(wrapper.findComponent(MarkerListEditor).exists()).toBe(true);
      wrapper.unmount();
    });

    it('switches tabs with arrow keys and keeps focus on the selected tab', async () => {
      const wrapper = mount(ProjectListsPanel, { attachTo: document.body });
      const tablist = wrapper.find('[role="tablist"]');
      await tablist.trigger('keydown', { key: 'ArrowRight' });
      expect(wrapper.findComponent(TimeSignatureEditor).exists()).toBe(true);
      expect(document.activeElement).toBe(wrapper.find('[data-tab-id="meter"]').element);
      await tablist.trigger('keydown', { key: 'End' });
      expect(wrapper.findComponent(MarkerListEditor).exists()).toBe(true);
      expect(document.activeElement).toBe(wrapper.find('[data-tab-id="markers"]').element);
      wrapper.unmount();
    });

    it('forwards the playhead getter and seek events for markers', async () => {
      const wrapper = mount(ProjectListsPanel, { props: { positionPpq: () => 4 } });
      await buttonByText(wrapper, 'Markers').trigger('click');
      const markers = wrapper.findComponent(MarkerListEditor);
      await buttonByText(markers, 'Add at playhead').trigger('click');
      expect(store.markers[0].ppq).toBe(4);
      await markers.find('tbody tr').trigger('click');
      expect(wrapper.emitted('seek')).toEqual([[4]]);
      wrapper.unmount();
    });
  });
});

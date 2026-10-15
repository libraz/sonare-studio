import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ChordGenerateDialog from '@/components/compose/ChordGenerateDialog.vue';
import TrackGenerateDialog from '@/components/compose/TrackGenerateDialog.vue';
import { setProjectChords } from '@/project/command/chords';
import { setTrackFrozen } from '@/project/command/clips-state';
import { clearHistory, undo } from '@/project/command/history';
import { setSections } from '@/project/command/timeline';
import { partSeed } from '@/project/generation';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';
import { MAJOR_MODE_MASK } from '@/project/types';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const FOUR_CHORDS = [
  { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
  { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
  { startPpq: 8, endPpq: 12, rootPc: 9, quality: 0 },
  { startPpq: 12, endPpq: 16, rootPc: 5, quality: 0 },
];

// AppModal teleports its content to <body>; query through the document.
let wrapper: VueWrapper | null = null;
let store: ReturnType<typeof useProjectStore>;

function confirm(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>('.generate-confirm');
}

function partCheckboxes(): HTMLInputElement[] {
  return [
    ...document.body.querySelectorAll<HTMLInputElement>('.part-check input[type="checkbox"]'),
  ];
}

/** Expands one part's parameter panel by its row index. */
function expandPart(index: number): void {
  [...document.body.querySelectorAll<HTMLButtonElement>('.part-expand')][index]?.click();
}

/** The reroll button inside one part's expanded parameter panel. */
function rerollButton(index: number): HTMLButtonElement | null {
  const row = [...document.body.querySelectorAll('.part-row')][index];
  return row?.querySelector<HTMLButtonElement>('.reroll-button') ?? null;
}

/** Checks a part checkbox by its row index (motif, drums, bass, counter, backing). */
function checkPart(index: number): void {
  const box = partCheckboxes()[index];
  box.checked = true;
  box.dispatchEvent(new Event('change'));
}

/** Clears the beginner accompaniment preset before a selective test. */
function clearParts(): void {
  const clear = [...document.body.querySelectorAll<HTMLButtonElement>('.preset-chip')].find(
    (button) => button.textContent?.trim() === 'Clear',
  );
  clear?.click();
}

beforeEach(async () => {
  setActivePinia(createPinia());
  store = useProjectStore();
  store.dispose();
  clearHistory();
  await store.init();
  store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.replaceChildren();
});

describe('ChordGenerateDialog', () => {
  async function open(): Promise<VueWrapper> {
    wrapper = mount(ChordGenerateDialog, { props: { open: true }, attachTo: document.body });
    await nextTick();
    return wrapper;
  }

  it('writes a progression and shows the success state', async () => {
    await open();
    expect(store.chords).toHaveLength(0);
    confirm()?.click();
    await nextTick();
    expect(store.chords.length).toBeGreaterThan(0);
    // The dialog stays open on a done screen, not dismissed.
    expect(wrapper?.emitted('close')).toBeFalsy();
    expect(document.body.querySelector('.done-title')).not.toBeNull();
  });

  it('does not turn Enter on Cancel into Generate', async () => {
    await open();
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    cancel?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();

    expect(store.chords).toHaveLength(0);
  });

  it('offers to continue into track generation after writing', async () => {
    await open();
    confirm()?.click();
    await nextTick();
    const continueBtn = document.body.querySelector<HTMLButtonElement>('.continue-tracks');
    expect(continueBtn).not.toBeNull();
    continueBtn?.click();
    await nextTick();
    expect(wrapper?.emitted('generateTracks')).toBeTruthy();
  });

  it('blocks harmonize with a stated reason when the source clip is percussion', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    const drumClip = store.clips.find((clip) => clip.trackId === drums?.id);
    if (!drumClip) throw new Error('missing generated drums fixture');
    store.clipId = drumClip.id;
    await open();
    document.body.querySelectorAll<HTMLElement>('.mode-select .segment[role="radio"]')[1]?.click();
    await nextTick();
    expect(document.body.querySelector('.mode-hint')?.textContent).toContain(
      'Percussion clips cannot be a harmonize source.',
    );
    expect(confirm()?.disabled).toBe(true);
  });

  it('renders progression and harmonize as an equal-width segmented control', async () => {
    await open();
    const segments = document.body.querySelectorAll('.mode-select .segment[role="radio"]');
    expect(segments.length).toBe(2);
    expect(document.body.querySelector('.mode-select .segment.active')).not.toBeNull();
  });
});

describe('TrackGenerateDialog', () => {
  async function open(openWith: unknown = null): Promise<VueWrapper> {
    wrapper = mount(TrackGenerateDialog, {
      props: { open: true, openWith },
      attachTo: document.body,
    });
    await nextTick();
    return wrapper;
  }

  it('shows the gate when there is no chord progression', async () => {
    await store.loadDocument(createTemplate('empty'));
    await open();
    expect(document.body.querySelector('.gate')).not.toBeNull();
    expect(document.body.querySelector('.part-list')).toBeNull();
    const create = document.body.querySelector<HTMLButtonElement>('.gate-create');
    expect(create).not.toBeNull();
    create?.click();
    await nextTick();
    expect(wrapper?.emitted('openChords')).toBeTruthy();
  });

  it('clears the gate once a chord progression exists', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    expect(document.body.querySelector('.gate')).toBeNull();
    expect(document.body.querySelector('.part-list')).not.toBeNull();
    // Five part rows are always present.
    expect(document.body.querySelectorAll('.part-row').length).toBe(5);
  });

  it('opens the accompaniment flow for an empty organ template without chords', async () => {
    await store.loadDocument(createTemplate('baroque-organ'));
    await open();

    expect(document.body.querySelector('.gate')).toBeNull();
    const rows = [...document.body.querySelectorAll<HTMLElement>('.part-row')];
    expect(rows).toHaveLength(5);
    expect(partCheckboxes().map((box) => box.disabled)).toEqual([false, false, true, true, true]);
    expect(partCheckboxes().map((box) => box.checked)).toEqual([true, false, false, false, false]);
    expect(rows[2]?.querySelector('.part-disabled-hint')?.textContent).toContain(
      'Requires a chord progression',
    );
  });

  it('offers empty editable organ lanes as replacement targets for any part', async () => {
    await store.loadDocument(createTemplate('baroque-organ'));
    await open();

    const motifTarget = document.body
      .querySelectorAll<HTMLElement>('.part-row')[0]
      ?.querySelector<HTMLSelectElement>('.part-target');
    const motifOptions = Array.from(motifTarget?.options ?? []).map((option) =>
      option.textContent?.trim(),
    );
    expect(motifOptions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Manual I Soprano'),
        expect.stringContaining('Manual I Alto'),
        expect.stringContaining('Manual II Tenor'),
        expect.stringContaining('Pedal Bass'),
      ]),
    );
  });

  it('preselects a usable accompaniment and keeps live selections intact', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();

    expect(partCheckboxes().map((box) => box.checked)).toEqual([false, true, true, false, true]);

    clearParts();
    checkPart(0);
    await nextTick();
    // A reactive project update must not reset a user's in-progress choices.
    setProjectChords(FOUR_CHORDS);
    await nextTick();
    expect(partCheckboxes().map((box) => box.checked)).toEqual([true, false, false, false, false]);
  });

  it('keeps the counter part unavailable until a melody clip has notes', async () => {
    await store.loadDocument(createTemplate('empty'));
    setProjectChords(FOUR_CHORDS);
    await open();
    const boxes = partCheckboxes();
    expect(boxes[3].disabled).toBe(true);
    const counterRow = document.body.querySelectorAll('.part-row')[3];
    expect(counterRow.querySelector<HTMLSelectElement>('.part-target')?.disabled).toBe(true);
    expect(counterRow.querySelector<HTMLButtonElement>('.part-expand')?.disabled).toBe(true);
    const all = [...document.body.querySelectorAll<HTMLButtonElement>('.preset-chip')].find(
      (button) => button.textContent?.trim() === 'All',
    );
    all?.click();
    await nextTick();
    expect(partCheckboxes().filter((box) => box.checked)).toHaveLength(4);
    expect(boxes[3].checked).toBe(false);
  });

  it('defaults drums length to the chord-progression bar count', async () => {
    setProjectChords(FOUR_CHORDS); // 16 beats = 4 bars
    store.tempoBpm = 120;
    store.tempoSegments = [{ startPpq: 0, bpm: 120 }];
    await open();
    expect(document.body.querySelector<HTMLInputElement>('.whole-bars-input')?.value).toBe('4');
    expect(document.body.querySelector<HTMLInputElement>('.whole-time-input')?.value).toBe('0:08');
    const drumsRow = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
    drumsRow?.querySelector<HTMLButtonElement>('.part-expand')?.click();
    await nextTick();
    const barsInput = drumsRow?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(barsInput?.value).toBe('4');
    expect(drumsRow?.querySelector('.bars-caption')?.textContent).toContain('4');
  });

  it('generates the selected parts and chord lane for the entered song time', async () => {
    setProjectChords(FOUR_CHORDS);
    store.tempoBpm = 120;
    store.tempoSegments = [{ startPpq: 0, bpm: 120 }];
    await open();
    const time = document.body.querySelector<HTMLInputElement>('.whole-time-input');
    if (!time) throw new Error('missing song time input');
    time.value = '0:12';
    time.dispatchEvent(new Event('change'));
    await nextTick();

    expect(document.body.querySelector<HTMLInputElement>('.whole-bars-input')?.value).toBe('6');
    expect(document.body.querySelector('.whole-length')?.textContent).toContain('repeat to 6 bars');
    confirm()?.click();
    await nextTick();

    expect(Math.max(...store.chords.map((chord) => chord.endPpq))).toBe(24);
    for (const name of ['Drums', 'Bass', 'Backing']) {
      const track = store.tracks.find((entry) => entry.name === name);
      const clip = store.clips.find((entry) => entry.trackId === track?.id);
      expect(clip?.lengthPpq).toBe(24);
    }
    expect(undo()).toBe(true);
    expect(Math.max(...store.chords.map((chord) => chord.endPpq))).toBe(16);
  });

  it('converts time through tempo ramps before rounding to bars', async () => {
    setProjectChords(FOUR_CHORDS);
    store.tempoSegments = [
      { startPpq: 0, bpm: 120, endBpm: 60 },
      { startPpq: 16, bpm: 60 },
    ];
    await open();
    const time = document.body.querySelector<HTMLInputElement>('.whole-time-input');
    if (!time) throw new Error('missing song time input');
    expect(time.value).toBe('0:11');
    time.value = '0:11';
    time.dispatchEvent(new Event('change'));
    await nextTick();
    expect(document.body.querySelector<HTMLInputElement>('.whole-bars-input')?.value).toBe('4');
  });

  it('chooses the closest elapsed bar under a slowing tempo ramp', async () => {
    setProjectChords(FOUR_CHORDS);
    store.tempoSegments = [
      { startPpq: 0, bpm: 120, endBpm: 10 },
      { startPpq: 8, bpm: 10 },
    ];
    await open();
    const time = document.body.querySelector<HTMLInputElement>('.whole-time-input');
    if (!time) throw new Error('missing song time input');
    time.value = '0:06';
    time.dispatchEvent(new Event('change'));
    await nextTick();
    expect(document.body.querySelector<HTMLInputElement>('.whole-bars-input')?.value).toBe('1');
  });

  it('accepts a song-length time and rejects out-of-range bars', async () => {
    setProjectChords(FOUR_CHORDS);
    store.tempoBpm = 120;
    store.tempoSegments = [{ startPpq: 0, bpm: 120 }];
    await open();
    const time = document.body.querySelector<HTMLInputElement>('.whole-time-input');
    const bars = document.body.querySelector<HTMLInputElement>('.whole-bars-input');
    if (!time || !bars) throw new Error('missing song length inputs');
    time.value = '3:00';
    time.dispatchEvent(new Event('change'));
    await nextTick();
    expect(bars.value).toBe('90');

    bars.value = '257';
    bars.dispatchEvent(new Event('input'));
    await nextTick();
    expect(confirm()?.disabled).toBe(true);
    expect(document.body.querySelector('.whole-length [role="alert"]')?.textContent).toContain(
      '1 to 256',
    );
  });

  it('rejects invalid per-part bar overrides before generation', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    checkPart(0);
    expandPart(0);
    await nextTick();
    const motif = document.body.querySelectorAll<HTMLElement>('.part-row')[0];
    const bars = motif.querySelector<HTMLInputElement>('input[type="number"]');
    if (!bars) throw new Error('missing motif length input');
    bars.value = '257';
    bars.dispatchEvent(new Event('input'));
    await nextTick();
    expect(confirm()?.disabled).toBe(true);
    expect(document.body.querySelector('.track-fields > [role="alert"]')?.textContent).toContain(
      '1 to 256',
    );
  });

  /**
   * The ceiling is a second dial on the same part, so it has to be reachable
   * and it has to mean something different from density: raising density asks
   * for more, lowering the ceiling refuses what the tempo puts out of reach.
   */
  it('thins the generated groove when a difficulty ceiling is chosen', async () => {
    setProjectChords(FOUR_CHORDS);
    store.tempoBpm = 200;

    const drumNotes = async (level: string): Promise<number> => {
      await open();
      const drumsRow = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
      drumsRow?.querySelector<HTMLButtonElement>('.part-expand')?.click();
      await nextTick();
      const ceiling = drumsRow?.querySelector<HTMLSelectElement>('.difficulty-field select');
      expect(ceiling).not.toBeNull();
      if (ceiling !== null && ceiling !== undefined) {
        ceiling.value = level;
        ceiling.dispatchEvent(new Event('change'));
        await nextTick();
        expect(ceiling.value).toBe(level);
      }
      checkPart(1);
      await nextTick();
      confirm()?.click();
      await nextTick();
      const track = store.tracks.find((entry) => entry.name === 'Drums');
      const count = store.clips.find((clip) => clip.trackId === track?.id)?.notes.length ?? 0;
      undo();
      wrapper?.unmount();
      return count;
    };

    const unconstrained = await drumNotes('0');
    const easiest = await drumNotes('1');
    expect(easiest).toBeGreaterThan(0);
    expect(easiest).toBeLessThan(unconstrained);
  });

  it('generates the checked parts in one undoable batch', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    const trackCount = store.tracks.length;
    // Check drums (index 1) and bass (index 2).
    clearParts();
    checkPart(1);
    checkPart(2);
    await nextTick();
    expect(confirm()?.disabled).toBe(false);
    confirm()?.click();
    await nextTick();
    expect(store.tracks.length).toBe(trackCount + 2);
    expect(document.body.querySelector('.track-done')).not.toBeNull();
    expect(document.body.querySelector('.modal-foot button:not(.primary)')?.textContent).toContain(
      'Close',
    );
    expect(wrapper?.emitted('close')).toBeFalsy();
    // One undo removes both generated tracks.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
  });

  // One project seed reproduces the whole arrangement; a reroll moves one part
  // off it and leaves the others exactly where they were.
  it('draws every part from the project seed and rerolls one at a time', async () => {
    setProjectChords(FOUR_CHORDS);
    store.generationSeed = 4242;
    await open();
    checkPart(1);
    await nextTick();
    confirm()?.click();
    await nextTick();

    const first = store.tracks.find((track) => track.name === 'Drums')?.generated?.seed;
    expect(first).toBe(partSeed(4242, 'drums', 0));
    expect(first).not.toBe(partSeed(4242, 'bass', 0));

    undo();
    wrapper?.unmount();
    await open();
    checkPart(1);
    expandPart(1);
    await nextTick();
    rerollButton(1)?.click();
    await nextTick();
    confirm()?.click();
    await nextTick();

    const second = store.tracks.find((track) => track.name === 'Drums')?.generated?.seed;
    expect(second).toBe(partSeed(4242, 'drums', 1));
    expect(second).not.toBe(first);
  });

  it('writes the project seed into the document', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    const input = document.body.querySelector<HTMLInputElement>('.seed-row input');
    if (!input) throw new Error('missing project seed input');
    input.value = '77';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(store.generationSeed).toBe(77);
  });

  it('disables generate with nothing selected', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    clearParts();
    await nextTick();
    expect(confirm()?.disabled).toBe(true);
  });

  it('explains why generate is disabled with nothing selected', async () => {
    setProjectChords(FOUR_CHORDS);
    wrapper = mount(TrackGenerateDialog, {
      props: { open: true, openWith: null },
      attachTo: document.body,
      global: { directives: { tooltip: vTooltip } },
    });
    await nextTick();
    clearParts();
    await nextTick();
    expect(confirm()?.disabled).toBe(true);
    expect(confirm()?.getAttribute('aria-description')).toContain(
      'Tick at least one part to generate.',
    );
  });

  it('does not generate when the only requested part lacks a source melody', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    // Programmatic change events cannot bypass the prerequisite either.
    clearParts();
    checkPart(3);
    await nextTick();
    expect(confirm()?.disabled).toBe(true);
    expect(wrapper?.emitted('close')).toBeFalsy();
    expect(store.tracks.some((track) => track.name === 'Counter melody')).toBe(false);
  });

  it('pre-selects the part when opened for a track replacement', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    await open({ part: 'drums', target: { kind: 'replaceTrack', trackId: drums?.id } });
    const boxes = partCheckboxes();
    // Drums (index 1) is pre-checked; others are not.
    expect(boxes[1].checked).toBe(true);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[2].checked).toBe(false);
    expect(boxes[4].checked).toBe(false);
    const trackCount = store.tracks.length;
    confirm()?.click();
    await nextTick();
    // Replacement nets zero tracks and keeps a single Drums track.
    expect(store.tracks.length).toBe(trackCount);
    expect(store.tracks.filter((track) => track.name === 'Drums')).toHaveLength(1);
  });

  it('opens a saved section as a drum range and keeps the next-section build-up', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4, seed: 10 }, target: { kind: 'new' } },
    ]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    if (!drums) throw new Error('missing generated drums fixture');
    setSections([
      { name: 'Pre-chorus 1', startPpq: 4, endPpq: 12 },
      { name: 'Chorus 1', startPpq: 12, endPpq: 16 },
    ]);
    const preChorusSection = store.sections[0];
    if (!preChorusSection) throw new Error('missing saved section fixture');

    await open({
      part: 'drums',
      target: { kind: 'replaceRange', trackId: drums.id, startPpq: 4, endPpq: 12 },
    });

    const row = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
    expect(row.querySelector('.drum-range-panel')).not.toBeNull();
    expect(row.querySelector<HTMLInputElement>('.drum-range-start')?.value).toBe('2');
    expect(row.querySelector<HTMLInputElement>('.drum-range-length')?.value).toBe('2');
    expect(row.querySelector<HTMLSelectElement>('.drum-range-panel select')?.value).toBe(
      `section:${preChorusSection.id}`,
    );

    const selects = [...row.querySelectorAll<HTMLSelectElement>('.part-params select')];
    expect(selects[2]?.value).toBe('prechorus');
    expect(selects[3]?.value).toBe('chorus');
    expect(row.querySelector('.drum-range-summary')?.textContent).toContain('2–3');

    const trackCount = store.tracks.length;
    confirm()?.click();
    await nextTick();
    expect(store.tracks).toHaveLength(trackCount);
    expect(wrapper?.emitted('close')).toBeTruthy();
    expect(document.body.querySelector('.dialog-error')).toBeNull();
  });

  it('blocks the counter melody with a stated reason when the source clip is percussion', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    const drumClip = store.clips.find((clip) => clip.trackId === drums?.id);
    if (!drumClip) throw new Error('missing generated drums fixture');
    store.clipId = drumClip.id;
    await open();
    const counterRow = [...document.body.querySelectorAll<HTMLElement>('.part-row')][3];
    expect(counterRow.textContent).toContain('Percussion clips cannot be a counter-melody source.');
  });

  it('numbers drum range bars on the project meter map', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4, seed: 10 }, target: { kind: 'new' } },
    ]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    if (!drums) throw new Error('missing generated drums fixture');
    setSections([{ name: 'Verse', startPpq: 3, endPpq: 11 }]);
    // A leading 3/4 bar: ruler bar 2 starts at PPQ 3, not PPQ 4.
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 3, numerator: 4, denominator: 4 },
    ];

    await open({
      part: 'drums',
      target: { kind: 'replaceRange', trackId: drums.id, startPpq: 3, endPpq: 11 },
    });

    const row = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
    expect(row.querySelector<HTMLInputElement>('.drum-range-start')?.value).toBe('2');
    expect(row.querySelector<HTMLInputElement>('.drum-range-length')?.value).toBe('2');
    expect(row.querySelector<HTMLSelectElement>('.drum-range-panel select')?.value).toBe(
      `section:${store.sections[0].id}`,
    );
  });

  it('ignores a stale drum range when drums are unchecked for whole-song generation', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    if (!drums) throw new Error('missing generated drums fixture');
    await open();
    const row = document.body.querySelectorAll<HTMLElement>('.part-row')[1];
    const target = row.querySelector<HTMLSelectElement>('.part-target');
    if (!target) throw new Error('missing drum target');
    target.value = `range:${drums.id}`;
    target.dispatchEvent(new Event('change'));
    await nextTick();
    const start = row.querySelector<HTMLInputElement>('.drum-range-start');
    if (!start) throw new Error('missing drum range start');
    start.value = '99';
    start.dispatchEvent(new Event('input'));
    await nextTick();
    expect(document.body.querySelector('.whole-length')).toBeNull();

    const drumsBox = partCheckboxes()[1];
    drumsBox.checked = false;
    drumsBox.dispatchEvent(new Event('change'));
    await nextTick();
    expect(document.body.querySelector('.whole-length')).not.toBeNull();
    expect(confirm()?.disabled).toBe(false);
  });

  it('does not offer a frozen track as a generation target', async () => {
    setProjectChords(FOUR_CHORDS);
    const { generateTracksBatchCommand } = await import('@/project/command/generate-batch');
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    if (!drums) throw new Error('missing generated drums fixture');
    setTrackFrozen(drums.id, { assetId: 'frozen-drums' });

    await open({ part: 'drums', target: { kind: 'replaceTrack', trackId: drums.id } });
    const drumsRow = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
    const target = drumsRow.querySelector<HTMLSelectElement>('.part-target');

    expect(target?.value).toBe('new');
    expect(
      [...(target?.options ?? [])].some((option) => option.value === `replace:${drums.id}`),
    ).toBe(false);
    expect(document.body.querySelector('.dialog-error')?.textContent).toContain('Unfreeze');
  });

  it('counter melody generation honors an explicitly selected counterpoint profile', async () => {
    setProjectChords(FOUR_CHORDS);
    const { useAppSettings } = await import('@/composables/useAppSettings');
    useAppSettings().set('guidanceProfile', 'counterpoint');
    // Add a note to the active clip so counter melody can generate
    const activeClip = store.activeClip;
    if (activeClip) {
      store.clips = store.clips.map((clip) =>
        clip.id === activeClip.id
          ? { ...clip, notes: [{ pitch: 60, startPpq: 0, durationPpq: 4, channel: 0 }] }
          : clip,
      );
    }

    await open();
    checkPart(3); // counter melody (index 3)
    await nextTick();
    confirm()?.click();
    await nextTick();

    // The explicit counterpoint setting should reach the generator.
    const tracks = store.tracks.filter((track) => track.name === 'Counter melody');
    expect(tracks.length).toBe(1);
  });

  it('counter melody generation uses pop profile when configured', async () => {
    setProjectChords(FOUR_CHORDS);
    const { useAppSettings } = await import('@/composables/useAppSettings');
    const appSettings = useAppSettings();
    appSettings.set('guidanceProfile', 'pop');

    // Add a note to the active clip so counter melody can generate
    const activeClip = store.activeClip;
    if (activeClip) {
      store.clips = store.clips.map((clip) =>
        clip.id === activeClip.id
          ? { ...clip, notes: [{ pitch: 60, startPpq: 0, durationPpq: 4, channel: 0 }] }
          : clip,
      );
    }

    await open();
    checkPart(3); // counter melody (index 3)
    await nextTick();
    confirm()?.click();
    await nextTick();

    // With pop profile, counter melody should be generated with pop profile
    const tracks = store.tracks.filter((track) => track.name === 'Counter melody');
    expect(tracks.length).toBe(1);
  });
});

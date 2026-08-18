import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ChordGenerateDialog from '@/components/compose/ChordGenerateDialog.vue';
import TrackGenerateDialog from '@/components/compose/TrackGenerateDialog.vue';
import { setProjectChords } from '@/project/command/chords';
import { setTrackFrozen } from '@/project/command/clips-state';
import { clearHistory, undo } from '@/project/command/history';
import { partSeed } from '@/project/generation';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

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

  it('defaults drums length to the chord-progression bar count', async () => {
    setProjectChords(FOUR_CHORDS); // 16 beats = 4 bars
    await open();
    const drumsRow = [...document.body.querySelectorAll<HTMLElement>('.part-row')][1];
    drumsRow?.querySelector<HTMLButtonElement>('.part-expand')?.click();
    await nextTick();
    const barsInput = drumsRow?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(barsInput?.value).toBe('4');
    expect(drumsRow?.querySelector('.bars-caption')?.textContent).toContain('4');
  });

  it('generates the checked parts in one undoable batch', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    const trackCount = store.tracks.length;
    // Check drums (index 1) and bass (index 2).
    checkPart(1);
    checkPart(2);
    await nextTick();
    expect(confirm()?.disabled).toBe(false);
    confirm()?.click();
    await nextTick();
    expect(store.tracks.length).toBe(trackCount + 2);
    expect(wrapper?.emitted('close')).toBeTruthy();
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
    expect(confirm()?.disabled).toBe(true);
  });

  it('keeps the dialog open and reports a zero-write generation', async () => {
    setProjectChords(FOUR_CHORDS);
    await open();
    // Counter melody has no prerequisite melody in the empty active clip.
    checkPart(3);
    await nextTick();
    confirm()?.click();
    await nextTick();
    expect(wrapper?.emitted('close')).toBeFalsy();
    expect(document.body.querySelector('.dialog-error')?.textContent).toContain('no changes');
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
    const trackCount = store.tracks.length;
    confirm()?.click();
    await nextTick();
    // Replacement nets zero tracks and keeps a single Drums track.
    expect(store.tracks.length).toBe(trackCount);
    expect(store.tracks.filter((track) => track.name === 'Drums')).toHaveLength(1);
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
});

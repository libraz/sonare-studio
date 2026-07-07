import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import GenerateDialog from '@/components/compose/GenerateDialog.vue';
import { clearHistory } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

// AppModal teleports its content to <body>; query through the document.
let wrapper: VueWrapper | null = null;
let store: ReturnType<typeof useProjectStore>;

async function open(): Promise<VueWrapper> {
  wrapper = mount(GenerateDialog, { props: { open: true }, attachTo: document.body });
  await nextTick();
  return wrapper;
}

function confirm(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>('.generate-confirm');
}

function modeSegments(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.mode-select .mode-segment')];
}

async function selectMode(label: string): Promise<void> {
  const segment = modeSegments().find((el) => el.textContent?.trim() === label);
  expect(segment).toBeDefined();
  segment?.click();
  await nextTick();
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
  document.body.innerHTML = '';
});

describe('GenerateDialog', () => {
  it('generates a progression into the chord track and closes', async () => {
    await open();
    expect(store.chords).toHaveLength(0);
    confirm()?.click();
    await nextTick();
    expect(store.chords.length).toBeGreaterThan(0);
    expect(wrapper?.emitted('close')).toBeTruthy();
  });

  it('offers style segments as an equal-width segmented control', async () => {
    await open();
    const segments = document.body.querySelectorAll('.style-select .segment[role="radio"]');
    // Four style options are always present (append mode row appears only with
    // an existing chord track).
    expect(segments.length).toBe(4);
    expect(document.body.querySelector('.style-select .segment.active')).not.toBeNull();
  });

  it('offers every generator and defaults to the progression form', async () => {
    await open();
    expect(modeSegments().length).toBe(8);
    expect(document.body.querySelector('.style-select')).not.toBeNull();
  });

  it('shows the arrangement part toggles after switching the generator', async () => {
    await open();
    await selectMode('Arrangement');
    const toggles = document.body.querySelectorAll('.check-group .check-label');
    expect(toggles.length).toBe(4);
    expect(confirm()?.disabled).toBe(false);
  });

  it('blocks the backing generator until a chord track exists', async () => {
    await open();
    await selectMode('Backing');
    const hint = document.body.querySelector('.mode-hint');
    expect(hint?.textContent).toContain('Generate a chord progression first.');
    expect(confirm()?.disabled).toBe(true);
  });

  it('shows the drum options after switching the generator', async () => {
    await open();
    await selectMode('Drums');
    expect(document.body.querySelector('.groove-select')).not.toBeNull();
    expect(document.body.querySelector('.section-select')).not.toBeNull();
    expect(document.body.querySelector('.density-input')).not.toBeNull();
    expect(document.body.querySelector('.style-select')).toBeNull();
  });

  it('blocks the bass generator until a chord track exists', async () => {
    await open();
    expect(store.chords).toHaveLength(0);
    await selectMode('Bass');
    const hint = document.body.querySelector('.mode-hint');
    expect(hint?.textContent).toContain('Generate a chord progression first.');
    expect(confirm()?.disabled).toBe(true);
  });
});

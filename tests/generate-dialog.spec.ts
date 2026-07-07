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
    const segments = document.body.querySelectorAll('.segment[role="radio"]');
    // Four style options are always present (append mode row appears only with
    // an existing chord track).
    expect(segments.length).toBe(4);
    expect(document.body.querySelector('.segment.active')).not.toBeNull();
  });
});

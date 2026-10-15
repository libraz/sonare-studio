import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePianoRollNoteMenu } from '@/components/piano-roll/use-piano-roll-note-menu';
import * as commands from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';

vi.mock('@/project/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/commands')>()),
  deleteNotes: vi.fn(),
  duplicateSelection: vi.fn(() => []),
  repeatSelection: vi.fn(() => []),
  setSelection: vi.fn(),
}));
vi.mock('@/ui/menu/context-menu', () => ({ openContextMenu: vi.fn() }));
vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function find(items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.children ? find(item.children, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

describe('piano-roll note context menu', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    vi.mocked(commands.deleteNotes).mockClear();
    vi.mocked(commands.duplicateSelection).mockClear();
    vi.mocked(commands.repeatSelection).mockClear();
    vi.mocked(openContextMenu).mockClear();
  });

  function openOnNote() {
    const store = useProjectStore();
    store.notes = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      pitch: 60 + index,
      velocity: 96,
      startPpq: 5 + index * 0.25,
      durationPpq: 0.25,
      channel: 0,
    }));
    store.selection = new Set(store.notes.map((note) => note.id));
    const menu = usePianoRollNoteMenu({
      contentReadOnly: ref(false),
      gridPpq: ref(0.5),
      snapPpq: (ppq) => ppq,
      barLengthPpq: () => 3,
    });
    menu.onNoteContext({ x: 0, y: 0, noteId: 3, ppq: 5.5 });
    return vi.mocked(openContextMenu).mock.calls[0][2];
  }

  it('deletes the whole selection', () => {
    const items = openOnNote();
    find(items, 'delete')?.run?.();
    expect(commands.deleteNotes).toHaveBeenCalledWith([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('duplicates by one grid step', () => {
    const items = openOnNote();
    find(items, 'duplicate-grid')?.run?.();
    expect(commands.duplicateSelection).toHaveBeenCalledWith(0.5);
  });

  it('repeats across bars at the bar length of the selection start', () => {
    const items = openOnNote();
    find(items, 'repeat-bar')?.run?.();
    expect(commands.repeatSelection).toHaveBeenCalledWith(3, 3);
  });
});

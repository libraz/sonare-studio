import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ContextMenuItem } from '@/ui/menu/context-menu';

let promptAnswer: string | null = null;
let setMarkerImpl: (id: number | null, ppq: number, name: string) => number = () => 1;
const markerCalls: Array<[number | null, number, string]> = [];
let menuItems: ContextMenuItem[] = [];

vi.mock('@/composables/useDialogs', () => ({
  promptDialog: async () => promptAnswer,
}));
vi.mock('@/project/commands', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setMarker: (id: number | null, ppq: number, name: string) => {
    markerCalls.push([id, ppq, name]);
    return setMarkerImpl(id, ppq, name);
  },
}));
vi.mock('@/ui/menu/context-menu', () => ({
  openContextMenu: (_x: number, _y: number, items: ContextMenuItem[]) => {
    menuItems = items;
  },
}));

const { useArrangementRulerMenu } = await import('@/ui/arrangement/use-arrangement-ruler-menu');

async function addMarker(answer: string | null): Promise<string> {
  promptAnswer = answer;
  const error = ref('');
  useArrangementRulerMenu({ error }).onRulerContext({ x: 0, y: 0, ppq: 8 });
  const item = menuItems.find((entry) => entry.id === 'marker');
  item?.run?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return error.value;
}

describe('ruler add-marker prompt', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    markerCalls.length = 0;
    setMarkerImpl = () => 1;
  });

  it('adds the trimmed name and ignores a blank one', async () => {
    await addMarker('   ');
    expect(markerCalls).toEqual([]);
    await addMarker('  Verse ');
    expect(markerCalls).toEqual([[null, 8, 'Verse']]);
  });

  it('shows a failed add in the error line', async () => {
    setMarkerImpl = () => {
      throw new RangeError('Marker ppq out of range');
    };
    expect(await addMarker('Chorus')).not.toBe('');
  });
});

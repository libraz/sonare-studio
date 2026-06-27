import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRedo,
  canUndo,
  clearAllMidiCcBindings,
  clearHistory,
  clearMidiCcBinding,
  redo,
  setMidiCcBinding,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('MIDI-learn binding commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('binds a target as an undoable edit', () => {
    setMidiCcBinding('gain:master', { channel: 0, controller: 7 });
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 0, controller: 7 });
    expect(canUndo()).toBe(true);

    undo();
    expect(store.midiCcBindings.has('gain:master')).toBe(false);

    redo();
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 0, controller: 7 });
  });

  it('rebinding the same target keeps the prior binding recoverable by undo', () => {
    setMidiCcBinding('gain:master', { channel: 0, controller: 7 });
    setMidiCcBinding('gain:master', { channel: 1, controller: 10 });
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 1, controller: 10 });

    undo();
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 0, controller: 7 });
  });

  it('clears a single binding reversibly and reports whether one existed', () => {
    setMidiCcBinding('pan:0', { channel: 2, controller: 9 });
    expect(clearMidiCcBinding('pan:0')).toBe(true);
    expect(store.midiCcBindings.has('pan:0')).toBe(false);

    // Clearing an unbound target is a no-op with no history entry.
    expect(clearMidiCcBinding('pan:0')).toBe(false);

    undo();
    expect(store.midiCcBindings.get('pan:0')).toEqual({ channel: 2, controller: 9 });
  });

  it('clears every binding in one undoable step (undo restores them all)', () => {
    setMidiCcBinding('gain:master', { channel: 0, controller: 7 });
    setMidiCcBinding('pan:0', { channel: 0, controller: 8 });
    expect(store.midiCcBindings.size).toBe(2);

    expect(clearAllMidiCcBindings()).toBe(true);
    expect(store.midiCcBindings.size).toBe(0);

    undo();
    expect(store.midiCcBindings.size).toBe(2);
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 0, controller: 7 });
    expect(store.midiCcBindings.get('pan:0')).toEqual({ channel: 0, controller: 8 });

    redo();
    expect(store.midiCcBindings.size).toBe(0);
  });

  it('clear-all on an empty map is a no-op with no history entry', () => {
    expect(clearAllMidiCcBindings()).toBe(false);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });
});

import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import TranscribeDialog from '@/components/arrangement/TranscribeDialog.vue';
import { useProjectStore } from '@/project/store';
import type { EditorClip } from '@/project/types';

const commands = vi.hoisted(() => ({
  setActiveClip: vi.fn(),
  transcribeAudioClipToMidi: vi.fn(),
}));
vi.mock('@/project/commands', () => commands);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function audioClip(lengthPpq: number): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Source',
    startPpq: 0,
    lengthPpq,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'audio-1',
  };
}

describe('TranscribeDialog', () => {
  let store: ReturnType<typeof useProjectStore>;
  let wrapper: VueWrapper | null = null;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    await store.init();
    store.tempoBpm = 120;
    store.clips = [audioClip(4)];
    commands.transcribeAudioClipToMidi.mockReset();
    commands.setActiveClip.mockReset();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
  });

  function open(lengthPpq = 4): VueWrapper {
    store.clips = [audioClip(lengthPpq)];
    wrapper = mount(TranscribeDialog, {
      props: { open: true, clipId: 1 },
      attachTo: document.body,
    });
    return wrapper;
  }

  it('exposes equal-width accessible melody and polyphonic modes', async () => {
    commands.transcribeAudioClipToMidi.mockResolvedValue(2);
    const w = open();
    const modes = [...document.body.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(modes).toHaveLength(2);
    expect(modes[0]?.getAttribute('aria-checked')).toBe('true');
    modes[0]?.focus();
    modes[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(modes[1]);
    modes[1]?.click();
    await nextTick();
    expect(modes[1]?.getAttribute('aria-checked')).toBe('true');
    expect(modes[0]?.classList.contains('transcribe-mode-option')).toBe(true);
    expect(modes[1]?.classList.contains('transcribe-mode-option')).toBe(true);
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await nextTick();
    expect(commands.transcribeAudioClipToMidi).toHaveBeenCalledWith(1, {
      polyphonic: true,
      signal: expect.any(AbortSignal),
    });
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('disables polyphonic mode and explains the split action for long clips', () => {
    open(31 * 4);
    const poly = document.body.querySelectorAll<HTMLElement>('[role="radio"]')[1];
    expect(poly?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('Split');
  });

  it('cancels the active request and leaves a reopened dialog busy state intact', async () => {
    const pending: Array<{ resolve: (value: number) => void; signal: AbortSignal }> = [];
    commands.transcribeAudioClipToMidi.mockImplementation(
      (_id: number, options: { signal: AbortSignal }) => {
        return new Promise<number>((resolve) => {
          pending.push({ resolve, signal: options.signal });
        });
      },
    );
    const w = open();
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await nextTick();
    expect(document.body.textContent).toContain('Transcribing');
    // Native refreshes replace mirror objects even when the source identity is
    // unchanged. That must not cancel the request before its own commit.
    store.clips = store.clips.map((clip) => ({ ...clip }));
    await nextTick();
    expect(pending[0]?.signal.aborted).toBe(false);
    document.body.querySelector<HTMLButtonElement>('.modal-foot button')?.click();
    await nextTick();
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(w.emitted('close')).toHaveLength(1);

    // Simulate the parent closing and opening a fresh session before the old
    // promise settles. Its finally block must not clear the new busy state.
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await nextTick();
    expect(document.body.textContent).toContain('Transcribing');
    pending[0]?.resolve(-1);
    await nextTick();
    expect(document.body.textContent).toContain('Transcribing');
    pending[1]?.resolve(2);
    await nextTick();
  });
});

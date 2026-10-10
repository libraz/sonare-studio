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
  const fakeModule = {
    ...createFakeWasmModule(),
    tuningToReferenceHz: (tuning: number, a4 = 440) => a4 * 2 ** (tuning / 12),
  };
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
    const modes = [
      ...document.body.querySelectorAll<HTMLElement>('.transcribe-mode [role="radio"]'),
    ];
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
      tidy: false,
    });
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('passes the chosen shortest note and omits it on Auto', async () => {
    commands.transcribeAudioClipToMidi.mockResolvedValue(2);
    open();
    const notes = [
      ...document.body.querySelectorAll<HTMLElement>('.transcribe-shortest [role="radio"]'),
    ];
    expect(notes.map((el) => el.textContent?.trim())).toEqual(['Auto', '1/8', '1/16', '1/32']);
    expect(notes[0]?.getAttribute('aria-checked')).toBe('true');
    notes[0]?.focus();
    notes[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(notes[1]);
    notes[2]?.click();
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await nextTick();
    expect(commands.transcribeAudioClipToMidi).toHaveBeenCalledWith(1, {
      polyphonic: false,
      signal: expect.any(AbortSignal),
      tidy: false,
      minNoteDivision: 16,
    });
  });

  it('measures the tuning when detection is chosen and reports the reference pitch', async () => {
    commands.transcribeAudioClipToMidi.mockImplementation(
      async (_id: number, options: { onTuning?: (tuning: number) => void }) => {
        options.onTuning?.(-0.2);
        return 2;
      },
    );
    const w = open();
    const tuning = [
      ...document.body.querySelectorAll<HTMLElement>('.transcribe-tuning [role="radio"]'),
    ];
    expect(tuning.map((el) => el.textContent?.trim())).toEqual([
      'A4 = 440 Hz',
      'Detect from audio',
    ]);
    expect(tuning[0]?.getAttribute('aria-checked')).toBe('true');
    tuning[1]?.click();
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Detected tuning: A4 = 434.9 Hz'),
    );
    expect(commands.transcribeAudioClipToMidi).toHaveBeenCalledWith(1, {
      polyphonic: false,
      signal: expect.any(AbortSignal),
      tidy: false,
      referenceHz: 'auto',
      onTuning: expect.any(Function),
    });
    expect(commands.setActiveClip).toHaveBeenCalledWith(2);
    expect(w.emitted('close')).toBeUndefined();
    // The finished dialog offers only Close, so the clip cannot be transcribed twice.
    const actions = [...document.body.querySelectorAll<HTMLButtonElement>('button.primary')];
    expect(actions.map((el) => el.textContent?.trim())).toEqual(['Close']);
    actions[0]?.click();
    await nextTick();
    expect(w.emitted('close')).toHaveLength(1);
    expect(commands.transcribeAudioClipToMidi).toHaveBeenCalledTimes(1);
  });

  it('keeps polyphonic mode available for a clip longer than one detector request', () => {
    open(600 * (store.tempoBpm / 60));
    const poly = document.body.querySelectorAll<HTMLElement>('.transcribe-mode [role="radio"]')[1];
    expect(poly?.hasAttribute('disabled')).toBe(false);
  });

  it('passes the tidy choice and resets it when reopened', async () => {
    commands.transcribeAudioClipToMidi.mockResolvedValue(2);
    const w = open();
    const choices = [
      ...document.body.querySelectorAll<HTMLElement>('.transcribe-tidy [role="radio"]'),
    ];
    expect(choices.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    choices[0]?.focus();
    choices[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(choices[1]);
    expect(choices[1]?.getAttribute('aria-checked')).toBe('true');
    document.body.querySelector<HTMLButtonElement>('button.primary')?.click();
    await nextTick();
    expect(commands.transcribeAudioClipToMidi).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tidy: true }),
    );
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    const reopened = document.body.querySelectorAll<HTMLElement>('.transcribe-tidy [role="radio"]');
    expect(reopened[0]?.getAttribute('aria-checked')).toBe('true');
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

import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import TranscribeDialog from '@/components/arrangement/TranscribeDialog.vue';
import { useProjectStore } from '@/project/store';
import type { EditorClip } from '@/project/types';

vi.mock('@/project/commands', () => ({
  setActiveClip: vi.fn(),
  transcribeAudioClipToMidi: vi.fn(),
}));
vi.mock('@/composables/useDialogs', () => ({ confirmDialog: vi.fn() }));
vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

function audioClip(): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Source',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'audio-1',
  };
}

/** Every radio group in the dialog, in template order. */
const GROUPS = [
  '.transcribe-mode',
  '.transcribe-tuning',
  '.transcribe-shortest',
  '.transcribe-voices',
  '.transcribe-tempo',
  '.transcribe-tidy',
];

describe('TranscribeDialog radio groups', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tempoBpm = 120;
    store.clips = [audioClip()];
    wrapper = mount(TranscribeDialog, {
      props: { open: true, clipId: 1 },
      attachTo: document.body,
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
  });

  function radios(group: string): HTMLElement[] {
    return [
      ...document.body.querySelectorAll<HTMLElement>(`${group} [role="radio"]:not([disabled])`),
    ];
  }

  async function press(target: HTMLElement, key: string): Promise<void> {
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await nextTick();
  }

  it.each(GROUPS)(
    '%s follows the shared roving contract: End, wrap, Home, vertical arrows',
    async (group) => {
      // Voice count only applies to polyphonic transcription.
      if (group === '.transcribe-voices') {
        radios('.transcribe-mode')[1].click();
        await nextTick();
      }
      const options = radios(group);
      expect(options.length).toBeGreaterThanOrEqual(2);
      const last = options.length - 1;

      await press(options[0], 'End');
      expect(document.activeElement).toBe(radios(group)[last]);
      expect(radios(group)[last].getAttribute('aria-checked')).toBe('true');

      await press(radios(group)[last], 'ArrowRight');
      expect(document.activeElement).toBe(radios(group)[0]);
      expect(radios(group)[0].getAttribute('aria-checked')).toBe('true');

      await press(radios(group)[0], 'ArrowDown');
      expect(radios(group)[1].getAttribute('aria-checked')).toBe('true');

      await press(radios(group)[1], 'Home');
      expect(radios(group)[0].getAttribute('aria-checked')).toBe('true');
      expect(radios(group).map((option) => option.tabIndex)).toEqual(
        radios(group).map((_, index) => (index === 0 ? 0 : -1)),
      );
    },
  );
});

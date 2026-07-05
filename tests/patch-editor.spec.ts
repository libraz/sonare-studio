import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PatchEditor from '@/components/devices/PatchEditor.vue';
import { clearHistory, setTrackInstrument, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { selectOption } from './helpers/select-menu';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const auditionMock = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  stop: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@/ui/devices/audition', () => ({
  createPatchAudition: vi.fn(() => auditionMock),
}));

/** Creates a manually-settled promise for async race tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PatchEditor.vue', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
    trackId = store.tracks[0].id;
  });

  function mountOpen() {
    return mount(PatchEditor, { props: { open: true, trackId } });
  }

  it('renders nothing while closed', () => {
    const wrapper = mount(PatchEditor, { props: { open: false, trackId } });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('seeds the draft from the preset base values of the track instrument', () => {
    const wrapper = mountOpen();
    expect(wrapper.find('.patch-base').text()).toBe('based on e-piano');
    // fakeSynthPresetPatch reports cutoffHz 12000 / ampSustain 0.6.
    expect((wrapper.find('[data-field="cutoffHz"]').element as HTMLInputElement).value).toBe(
      '12000',
    );
    expect((wrapper.find('[data-field="ampSustain"]').element as HTMLInputElement).value).toBe(
      '0.6',
    );
  });

  it('applies edits as one undoable synth-patch instrument', async () => {
    const wrapper = mountOpen();
    await wrapper.find('[data-field="cutoffHz"]').setValue('800');
    await wrapper.find('[data-field="lfo2RateHz"]').setValue('4.5');
    const apply = wrapper.findAll('button').find((b) => b.text() === 'Apply');
    await apply?.trigger('click');

    expect(wrapper.emitted('applied')).toHaveLength(1);
    const instrument = store.tracks[0].instrument as {
      kind: string;
      patch: { preset?: string; cutoffHz?: number; ampSustain?: number; lfo2RateHz?: number };
    };
    expect(instrument.kind).toBe('synth-patch');
    expect(instrument.patch.preset).toBe('e-piano');
    expect(instrument.patch.cutoffHz).toBe(800);
    expect(instrument.patch.lfo2RateHz).toBe(4.5);
    // Untouched base values travel explicitly with the draft.
    expect(instrument.patch.ampSustain).toBe(0.6);

    expect(undo()).toBe(true);
    expect(store.tracks[0].instrument).toBeUndefined();
  });

  it('keeps edited mod-matrix rows and drops inert ones on apply', async () => {
    const wrapper = mountOpen();
    const addRow = wrapper.find('.mod-add');
    await addRow.trigger('click');
    await addRow.trigger('click');

    const rows = wrapper.findAll('.mod-row');
    expect(rows).toHaveLength(2);
    await selectOption(rows[0], '.mod-source', 'lfo1');
    await selectOption(rows[0], '.mod-destination', 'pitch-cents');
    await rows[0].find('.mod-depth').setValue('0.5');
    // The second row stays inert (none -> none) and must not be committed.

    const apply = wrapper.findAll('button').find((b) => b.text() === 'Apply');
    await apply?.trigger('click');
    const instrument = store.tracks[0].instrument as {
      patch: { modRoutings?: Array<{ source: string; destination: string; depth: number }> };
    };
    expect(instrument.patch.modRoutings).toEqual([
      { source: 'lfo1', destination: 'pitch-cents', depth: 0.5 },
    ]);
  });

  it('applies zero sustain as an explicit near-silent patch override', async () => {
    const wrapper = mountOpen();
    await wrapper.find('[data-field="ampSustain"]').setValue('0');
    const apply = wrapper.findAll('button').find((b) => b.text() === 'Apply');
    await apply?.trigger('click');

    const instrument = store.tracks[0].instrument as {
      kind: string;
      patch: { ampSustain?: number };
    };
    expect(instrument.kind).toBe('synth-patch');
    expect(instrument.patch.ampSustain).toBe(0.0001);
  });

  it('removes mod rows', async () => {
    const wrapper = mountOpen();
    await wrapper.find('.mod-add').trigger('click');
    expect(wrapper.findAll('.mod-row')).toHaveLength(1);
    await wrapper.find('.mod-remove').trigger('click');
    expect(wrapper.findAll('.mod-row')).toHaveLength(0);
  });

  it('auditions the current draft on a local preview player (never the engine)', async () => {
    const wrapper = mountOpen();
    await wrapper.find('[data-field="cutoffHz"]').setValue('440');
    const audition = wrapper.findAll('button').find((b) => b.text() === 'Audition');
    await audition?.trigger('click');

    expect(auditionMock.play).toHaveBeenCalledTimes(1);
    const [instrument] = auditionMock.play.mock.calls[0] as unknown as [
      { kind: string; patch: { cutoffHz?: number } },
    ];
    expect(instrument.kind).toBe('synth-patch');
    expect(instrument.patch.cutoffHz).toBe(440);
    // Nothing was committed to the track.
    expect(store.tracks[0].instrument).toBeUndefined();
  });

  it('ignores a stale audition failure after a newer audition succeeds', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    auditionMock.play.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mountOpen();
    const audition = wrapper.findAll('button').find((b) => b.text() === 'Audition');

    await audition?.trigger('click');
    await audition?.trigger('click');
    second.resolve();
    await Promise.resolve();
    first.reject(new Error('stale render failed'));
    await Promise.resolve();

    expect(auditionMock.play).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.patch-error').exists()).toBe(false);
  });

  it('does not show audition errors after unmount', async () => {
    const pending = deferred<void>();
    auditionMock.play.mockReturnValueOnce(pending.promise);
    const wrapper = mountOpen();
    const audition = wrapper.findAll('button').find((b) => b.text() === 'Audition');

    await audition?.trigger('click');
    wrapper.unmount();
    pending.reject(new Error('late render failed'));
    await Promise.resolve();

    expect(auditionMock.dispose).toHaveBeenCalledOnce();
    expect(wrapper.text()).not.toContain('late render failed');
  });

  it('emits close from Escape, the overlay and the Close button', async () => {
    const wrapper = mountOpen();
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    await wrapper.find('.patch-overlay').trigger('click');
    const close = wrapper.findAll('button').find((b) => b.text() === 'Close');
    await close?.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(3);
  });

  it('rebuilds the draft when reopened after the instrument changed', async () => {
    const wrapper = mount(PatchEditor, { props: { open: false, trackId } });
    setTrackInstrument(trackId, { kind: 'synth-patch', patch: { preset: 'saw-lead', drive: 0.9 } });
    await wrapper.setProps({ open: true });
    expect(wrapper.find('.patch-base').text()).toBe('based on saw-lead');
    expect((wrapper.find('[data-field="drive"]').element as HTMLInputElement).value).toBe('0.9');
  });
});

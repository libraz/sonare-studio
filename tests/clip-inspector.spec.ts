import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClipInspector from '@/components/arrangement/ClipInspector.vue';
import type { EditorClip } from '@/project/types';

const setClipGain = vi.fn();
const setClipFades = vi.fn();
const setClipLoop = vi.fn();

vi.mock('@/project/commands', () => ({
  setClipGain: (...args: unknown[]) => setClipGain(...args),
  setClipFades: (...args: unknown[]) => setClipFades(...args),
  setClipLoop: (...args: unknown[]) => setClipLoop(...args),
}));

function audioClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 7,
    trackId: 1,
    name: 'Loop A',
    startPpq: 0,
    lengthPpq: 16,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'asset-1',
    ...overrides,
  };
}

function midiClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return { ...audioClip(), kind: 'midi', assetId: undefined, ...overrides };
}

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

beforeEach(() => {
  setClipGain.mockClear();
  setClipFades.mockClear();
  setClipLoop.mockClear();
});

describe('ClipInspector', () => {
  it('renders nothing without a clip', () => {
    wrapper = mount(ClipInspector, { props: { clip: null } });
    expect(wrapper.find('.clip-inspector').exists()).toBe(false);
  });

  it('converts the gain field from dB to linear', async () => {
    wrapper = mount(ClipInspector, { props: { clip: audioClip() } });
    const gain = wrapper.find('input[aria-label="Clip gain in decibels"]');
    await gain.setValue('6');
    expect(setClipGain).toHaveBeenCalledTimes(1);
    const [id, linear] = setClipGain.mock.calls[0];
    expect(id).toBe(7);
    expect(linear).toBeCloseTo(10 ** (6 / 20), 4);
  });

  it('silences the clip at the gain floor', async () => {
    wrapper = mount(ClipInspector, { props: { clip: audioClip() } });
    await wrapper.find('input[aria-label="Clip gain in decibels"]').setValue('-60');
    expect(setClipGain).toHaveBeenCalledWith(7, 0);
  });

  it('clamps fade lengths to the clip length and keeps the other fade', async () => {
    wrapper = mount(ClipInspector, { props: { clip: audioClip({ fadeOutPpq: 2 }) } });
    await wrapper.find('input[aria-label="Fade-in length in beats"]').setValue('99');
    // fade-in clamped to lengthPpq (16); fade-out preserved at 2.
    expect(setClipFades).toHaveBeenCalledWith(7, 16, 2);
  });

  it('hides fade fields and re-detect for MIDI clips', () => {
    wrapper = mount(ClipInspector, { props: { clip: midiClip() } });
    expect(wrapper.find('input[aria-label="Fade-in length in beats"]').exists()).toBe(false);
    expect(wrapper.find('.ci-redetect').exists()).toBe(false);
  });

  it('toggles loop through the command', async () => {
    wrapper = mount(ClipInspector, { props: { clip: audioClip({ loopEnabled: false }) } });
    await wrapper.find('.ci-loop').trigger('click');
    expect(setClipLoop).toHaveBeenCalledWith(7, true);
  });

  it('emits redetect-tempo for audio clips', async () => {
    wrapper = mount(ClipInspector, { props: { clip: audioClip() } });
    await wrapper.find('.ci-redetect').trigger('click');
    expect(wrapper.emitted('redetectTempo')?.[0]).toEqual([7]);
  });
});

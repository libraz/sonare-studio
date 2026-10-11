import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollToolbar from '@/components/piano-roll/PianoRollToolbar.vue';
import ScoreToolbar from '@/components/score/ScoreToolbar.vue';
import { addNote, clearHistory, setSelection } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { en } from '@/ui/i18n/en';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const global = { directives: { tooltip: vTooltip } };

/** The button whose visible text is exactly `label`. */
function buttonByText(wrapper: ReturnType<typeof mount>, label: string) {
  const match = wrapper.findAll('button').find((button) => button.text().trim() === label);
  if (!match) throw new Error(`no button labelled ${label}`);
  return match;
}

describe('editor toolbar availability reasons', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function mountRollToolbar(overrides: Record<string, unknown> = {}) {
    return mount(PianoRollToolbar, {
      props: {
        overlayEnabled: true,
        fxPanelOpen: false,
        laneVisible: true,
        snapToScale: false,
        ghostMode: 'all',
        ghostHideMuted: true,
        noteColorMode: 'track',
        auditionDrag: true,
        autoReharmonize: false,
        placementGuide: true,
        guidanceTint: true,
        canTransform: true,
        clipId: store.clipId,
        noteCount: 0,
        ...overrides,
      },
      global,
      attachTo: document.body,
    });
  }

  it('cascades scale snap from the scale highlight, and drum tracks above both', async () => {
    store.scaleHighlight.enabled = false;
    const wrapper = mountRollToolbar();
    const scale = buttonByText(wrapper, en.shell.pianoRoll.snapScaleToggle);
    expect(scale.attributes('disabled')).toBeDefined();
    expect(scale.attributes('aria-description')).toContain(
      en.shell.editor.reasons.scaleHighlightOff,
    );

    await wrapper.setProps({ drumTrack: true });
    expect(scale.attributes('aria-description')).toContain(en.shell.editor.reasons.drumTrack);
    wrapper.unmount();
  });

  it('explains why the clip transforms are unavailable', () => {
    const frozen = mountRollToolbar({ canTransform: false, readOnly: true });
    const fx = buttonByText(frozen, en.shell.pianoRoll.midiFx);
    expect(fx.attributes('disabled')).toBeDefined();
    expect(fx.attributes('aria-description')).toContain(en.reasons.trackFrozen);
    frozen.unmount();

    const noClip = mountRollToolbar({ canTransform: false });
    expect(
      buttonByText(noClip, en.shell.pianoRoll.ornamentToggle).attributes('aria-description'),
    ).toContain(en.reasons.noMidiClip);
    noClip.unmount();
  });

  it('keeps ghost options in the View popover, gated on the overlay', async () => {
    const wrapper = mountRollToolbar({ overlayEnabled: false });
    expect(wrapper.find('.view-popover').exists()).toBe(false);

    await buttonByText(wrapper, en.shell.pianoRoll.view).trigger('click');
    const popover = wrapper.get('.view-popover');
    const hideMuted = popover
      .findAll('button')
      .find((button) => button.text().trim() === en.shell.pianoRoll.ghostHideMuted);
    expect(hideMuted?.attributes('disabled')).toBeDefined();
    expect(hideMuted?.attributes('aria-description')).toContain(en.shell.editor.reasons.overlayOff);
    wrapper.unmount();
  });

  it('disables the info line until notes are selected, and says so', async () => {
    const wrapper = mount(InfoLine, { global });
    const inputs = wrapper.findAll('input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain(en.reasons.noNoteSelection);

    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setSelection([id]);
    await wrapper.vm.$nextTick();
    for (const input of wrapper.findAll('input')) {
      expect(input.attributes('disabled')).toBeUndefined();
    }
    expect(wrapper.text()).not.toContain(en.reasons.noNoteSelection);
    wrapper.unmount();
  });

  it('names the missing prerequisite on the score export actions', async () => {
    const wrapper = mount(ScoreToolbar, {
      props: {
        dqOptions: [{ value: '1/16', label: '1/16' }],
        loading: false,
        exporting: false,
        pageCount: 0,
        hasXml: false,
        partName: '',
        zoomPercent: 100,
        zoomMin: 0.5,
        zoomMax: 2,
        zoomStep: 1.2,
        viewZoom: 1,
        transpose: 0,
        dqKey: '1/16',
        chordsEnabled: false,
        fullScoreEnabled: false,
        estimateFingering: false,
        annotateEnabled: false,
        pageFormat: 'a4',
        landscape: false,
        pageMarginMm: 10,
        scalePercent: 100,
        spacingStaff: 8,
        barsPerSystem: 0,
        barsPerPage: 0,
        grandStaffSplitPitch: 60,
        page: 1,
      } as never,
      global,
    });
    const score = en.shell.score;
    expect(buttonByText(wrapper, score.pdf).attributes('aria-description')).toContain(
      score.reasons.noScore,
    );

    await wrapper.setProps({ pageCount: 2, hasXml: true });
    const part = buttonByText(wrapper, score.partXml);
    expect(part.attributes('disabled')).toBeDefined();
    expect(part.attributes('aria-description')).toContain(score.reasons.noPart);
    expect(buttonByText(wrapper, score.pdf).attributes('disabled')).toBeUndefined();

    await wrapper.setProps({ exporting: true });
    expect(buttonByText(wrapper, score.musicXml).attributes('aria-description')).toContain(
      en.reasons.busy,
    );
    wrapper.unmount();
  });
});

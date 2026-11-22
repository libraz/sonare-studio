import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import ArrangementCanvas from '@/components/arrangement/ArrangementCanvas.vue';
import MixerFader from '@/components/mixer/MixerFader.vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import type { ClipDraftPreview } from '@/ui/arrangement/use-clip-interactions';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { FADER_MAX_DB, FADER_MIN_DB } from '@/ui/mixer/db-scale';
import {
  fakeAutomationInteractions,
  fakeClipInteractions,
  fakeNoteInteractions,
  fakeTakeInteractions,
} from './fakes/interactions';
import { editorClip, editorTrack } from './fakes/project';

/**
 * Accessibility contract of the highest-traffic interactive widgets: slider
 * semantics on the fader/knob and modal behavior of the template dialog.
 */

describe('MixerFader accessibility', () => {
  it('exposes full slider semantics', () => {
    const wrapper = mount(MixerFader, { props: { valueDb: -6 } });
    const slider = wrapper.find('[role="slider"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('aria-label')).toBe('Strip gain');
    expect(slider.attributes('aria-orientation')).toBe('vertical');
    expect(slider.attributes('aria-valuemin')).toBe(String(FADER_MIN_DB));
    expect(slider.attributes('aria-valuemax')).toBe(String(FADER_MAX_DB));
    expect(slider.attributes('aria-valuenow')).toBe('-6');
    expect(slider.attributes('aria-valuetext')).toContain('dB');
    expect(slider.attributes('tabindex')).toBe('0');
  });

  it('is keyboard operable via arrow keys', async () => {
    const wrapper = mount(MixerFader, { props: { valueDb: -6 } });
    await wrapper.find('[role="slider"]').trigger('keydown', { key: 'ArrowUp' });
    const emitted = wrapper.emitted('change');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]).toEqual([-5, true]);
  });

  it('uses a relative grab when pressing the fader thumb', async () => {
    const wrapper = mount(MixerFader, { props: { valueDb: -6, height: 100 } });
    const slider = wrapper.find('[role="slider"]');
    Object.defineProperty(slider.element, 'setPointerCapture', { value: () => undefined });
    Object.defineProperty(slider.element, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 100 }),
    });

    wrapper
      .find('.fader-thumb')
      .element.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 50 }),
      );
    await nextTick();
    expect(wrapper.emitted('change')).toBeUndefined();

    slider.element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 40 }));
    await nextTick();
    expect(wrapper.emitted('change')?.[0]?.[1]).toBe(false);
    slider.element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('change')?.at(-1)?.[1]).toBe(true);
  });

  it('removes itself from the tab order when disabled', () => {
    const wrapper = mount(MixerFader, { props: { valueDb: 0, disabled: true } });
    expect(wrapper.find('[role="slider"]').attributes('tabindex')).toBe('-1');
  });
});

describe('MixerKnob accessibility', () => {
  it('exposes full slider semantics', () => {
    const wrapper = mount(MixerKnob, {
      props: { value: 25, min: 0, max: 100, label: 'Pan' },
    });
    const slider = wrapper.find('[role="slider"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('aria-label')).toBe('Pan');
    expect(slider.attributes('aria-valuemin')).toBe('0');
    expect(slider.attributes('aria-valuemax')).toBe('100');
    expect(slider.attributes('aria-valuenow')).toBe('25');
    expect(slider.attributes('tabindex')).toBe('0');
  });

  it('removes the control menu outside-click listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(MixerKnob, {
      props: { value: 25, min: 0, max: 100, label: 'Pan' },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    await wrapper.find('.knob').trigger('contextmenu', { clientX: 5, clientY: 5 });

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });
});

describe('NewProjectDialog modal accessibility', () => {
  // AppModal teleports the dialog to <body>, so it is queried via the document.
  const dialogEl = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it('marks the dialog as modal with an accessible name', () => {
    const wrapper = mount(NewProjectDialog, { props: { open: true }, attachTo: document.body });
    const dialog = dialogEl();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('New project');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('keeps Tab cycling inside the dialog', async () => {
    const wrapper = mount(NewProjectDialog, {
      props: { open: true },
      attachTo: document.body,
    });
    const dialog = dialogEl() as HTMLElement;
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const last = buttons[buttons.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);

    // Tab from the last focusable element wraps to the first.
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await nextTick();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('restores focus to the previously focused element on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(NewProjectDialog, {
      props: { open: false },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(dialogEl());

    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
    trigger.remove();
    document.body.innerHTML = '';
  });
});

const painter: Painter = {
  schedule: () => {},
  dispose: () => {},
};

function stubCanvasEnvironment(): void {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

describe('Canvas editor live regions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('redraws the clip layer when a draw-tool draft changes', async () => {
    stubCanvasEnvironment();
    const schedule = vi.fn();
    const previewDraft = ref<ClipDraftPreview | null>(null);
    const wrapper = mount(ArrangementCanvas, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 480, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter: { schedule, dispose: () => {} },
        tracks: [editorTrack({ id: 1, name: 'Piano', color: '#60a5fa' })],
        clips: [],
        markers: [],
        activeTrackId: 1,
        activeClipId: -1,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        scrollY: 0,
        laneHeight: 80,
        rowLayout: buildRowLayout([false], 80),
        loopEnabled: false,
        loopStartPpq: 0,
        loopEndPpq: 4,
        interactions: fakeClipInteractions({ previewDraft }),
        automationExpandedIds: [],
        automationParams: {},
        automationLanes: [],
        automation: fakeAutomationInteractions(),
        takesExpandedIds: [],
        takes: fakeTakeInteractions(),
      },
    });

    schedule.mockClear();
    previewDraft.value = { trackId: 1, startPpq: 1, lengthPpq: 2 };
    await nextTick();

    expect(schedule).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('announces piano-roll note selection through a polite status region', () => {
    stubCanvasEnvironment();
    const wrapper = mount(NoteGridCanvas, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 480, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter,
        notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 1, durationPpq: 2, channel: 0 }],
        selection: new Set([1]),
        highlightedPitchClasses: Array.from({ length: 12 }, () => false),
        gridPpq: 0.25,
        clipLengthPpq: 16,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        interactions: fakeNoteInteractions(),
      },
    });

    const live = wrapper.get('[role="status"][aria-live="polite"]');
    expect(live.attributes('aria-atomic')).toBe('true');
    expect(live.text()).toContain('C4 selected');
  });

  it('localizes canvas live-region status when Japanese is selected', () => {
    stubCanvasEnvironment();
    useAppSettings().set('language', 'ja');
    const wrapper = mount(NoteGridCanvas, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 480, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter,
        notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 1, durationPpq: 2, channel: 0 }],
        selection: new Set([1]),
        highlightedPitchClasses: Array.from({ length: 12 }, () => false),
        gridPpq: 0.25,
        clipLengthPpq: 16,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        interactions: fakeNoteInteractions(),
      },
    });

    expect(wrapper.get('[role="status"]').text()).toContain('を選択');
    wrapper.unmount();
    useAppSettings().set('language', 'en');
  });

  it('announces arrangement track and clip selection through a polite status region', () => {
    stubCanvasEnvironment();
    const wrapper = mount(ArrangementCanvas, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 480, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter,
        tracks: [editorTrack({ id: 1, name: 'Piano', color: '#60a5fa' })],
        clips: [editorClip({ id: 2, trackId: 1, name: 'Intro', startPpq: 0, lengthPpq: 4 })],
        markers: [],
        activeTrackId: 1,
        activeClipId: 2,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        scrollY: 0,
        laneHeight: 80,
        rowLayout: buildRowLayout([false], 80),
        loopEnabled: false,
        loopStartPpq: 0,
        loopEndPpq: 4,
        interactions: fakeClipInteractions(),
        automationExpandedIds: [],
        automationParams: {},
        automationLanes: [],
        automation: fakeAutomationInteractions(),
        takesExpandedIds: [],
        takes: fakeTakeInteractions(),
      },
    });

    const live = wrapper.get('[role="status"][aria-live="polite"]');
    expect(live.attributes('aria-atomic')).toBe('true');
    expect(live.text()).toContain('Track Piano selected');
    expect(live.text()).toContain('Clip Intro selected');
  });

  it('exposes arrangement clips through keyboard and slider actions', async () => {
    stubCanvasEnvironment();
    const wrapper = mount(ArrangementCanvas, {
      props: {
        range: new TimelineRange({ widthPx: 800, heightPx: 480, pxPerPpq: 100, rowHeight: 10 }),
        revision: 0,
        painter,
        tracks: [editorTrack({ id: 1, name: 'Piano', color: '#60a5fa' })],
        clips: [editorClip({ id: 2, trackId: 1, name: 'Intro', startPpq: 0, lengthPpq: 4 })],
        markers: [],
        activeTrackId: 1,
        activeClipId: 2,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        scrollY: 0,
        laneHeight: 80,
        rowLayout: buildRowLayout([false], 80),
        loopEnabled: false,
        loopStartPpq: 0,
        loopEndPpq: 4,
        gridPpq: 0.25,
        interactions: fakeClipInteractions(),
        automationExpandedIds: [],
        automationParams: {},
        automationLanes: [],
        automation: fakeAutomationInteractions(),
        takesExpandedIds: [],
        takes: fakeTakeInteractions(),
      },
    });
    const navigator = wrapper.get('[role="listbox"]');
    expect(wrapper.get('[role="option"]').text()).toContain('Intro');
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(2);

    await navigator.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('clip-keyboard-action')?.[0]).toEqual([{ clipId: 2, kind: 'select' }]);
    await navigator.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(wrapper.emitted('clip-keyboard-action')?.[1]?.[0]).toMatchObject({
      clipId: 2,
      kind: 'adjust',
      adjustment: { direction: 'right', resize: true },
    });
  });
});

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { vi } from 'vitest';
import ArrangementCanvas from '@/components/arrangement/ArrangementCanvas.vue';
import ArrangementView from '@/components/arrangement/ArrangementView.vue';
import TrackHeaderList from '@/components/arrangement/TrackHeaderList.vue';
import { RULER_HEIGHT_PX } from '@/components/arrangement/theme';
import { type DialogRequest, dialogQueue, resolveDialog } from '@/composables/useDialogs';
import { useEditorTool } from '@/composables/useEditorTool';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { clearAudioClipData } from '@/ui/arrangement/audio-clip-data';
import { en } from '@/ui/i18n/en';
import {
  type ContextMenuItem,
  closeContextMenu,
  useContextMenuState,
} from '@/ui/menu/context-menu';
import { vTooltip } from '@/ui/tooltip';

/**
 * Mounts the real ArrangementView against a real Pinia project store and
 * exposes drivers that act the way a user does: right-clicks on the canvas,
 * keyboard edits through the clip navigator, wheel input, prompt answers.
 * Observations go through rendered DOM, the shared context-menu state, the
 * dialog queue and the store, never through the view's own internals.
 *
 * jsdom cannot lay out or paint, so three browser surfaces are stubbed:
 * `getContext` returns null (every painter skips its draw), `ResizeObserver`
 * reports a fixed content box once per observed element (so the shared
 * timeline gets a real viewport), and `requestAnimationFrame` never fires.
 *
 * `store.init()` loads the real libsonare module, which runs under jsdom; a
 * spec that mocks `@/lib/wasm` with the fake module gets that one instead.
 */

/** Content box the stubbed ResizeObserver reports for every observed element. */
export const VIEWPORT = { widthPx: 800, heightPx: 300 } as const;

/** A context-menu entry as a user sees it. */
export interface MenuEntry {
  id: string;
  label: string;
  /** Hover reason of a disabled entry; null when the entry is enabled. */
  disabledReason: string | null;
}

/** Options for {@link mountArrangementView}. */
export interface ArrangementViewMountOptions {
  /** Builds the document through project commands after the default project exists. */
  seed?: () => void | Promise<void>;
  /** Props forwarded to ArrangementView. */
  props?: InstanceType<typeof ArrangementView>['$props'];
}

/** Modifier keys accepted by {@link ArrangementViewHarness.pressClipKey}. */
export interface KeyModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** A child component found with `getComponent` (which drops `exists`). */
type ChildWrapper<T extends abstract new (...args: never) => unknown> = Omit<
  VueWrapper<InstanceType<T>>,
  'exists'
>;

/** A mounted ArrangementView with user-level drivers. */
export interface ArrangementViewHarness {
  wrapper: VueWrapper<InstanceType<typeof ArrangementView>>;
  store: ReturnType<typeof useProjectStore>;
  /** Right-clicks a clip (at `atPpq`, default its midpoint) and returns the menu shown. */
  openClipMenu(clipId: number, atPpq?: number): Promise<MenuEntry[]>;
  /** Right-clicks the bar ruler at `ppq` and returns the menu shown. */
  openRulerMenu(ppq: number): Promise<MenuEntry[]>;
  /** Runs an enabled entry of the open menu, as a click on it does. */
  runMenuItem(id: string): Promise<void>;
  /** Answers the pending prompt (null cancels) and returns what it asked. */
  answerPrompt(value: string | null): Promise<DialogRequest>;
  /** Presses the split tool on a clip at `ppq`. */
  splitWithTool(clipId: number, ppq: number): Promise<void>;
  /** Presses a key on the clip navigator with `clipId` as its active item. */
  pressClipKey(clipId: number, key: string, modifiers?: KeyModifiers): Promise<void>;
  /** Sets a clip's start or length through the navigator's range control. */
  setClipControl(clipId: number, control: 'start' | 'length', value: number): Promise<void>;
  /** Dispatches a wheel event on the track-header column or the canvas cell. */
  wheel(target: 'headers' | 'canvas', init: WheelEventInit): Promise<void>;
  /** Text of the view's error line, or '' when none is shown. */
  errorLine(): string;
  /** The real canvas child, whose props are the rendered timeline state. */
  canvas(): ChildWrapper<typeof ArrangementCanvas>;
  /** The real track-header child. */
  headers(): ChildWrapper<typeof TrackHeaderList>;
  /** Vertical offset the header column is rendered at (its translateY, negated). */
  headerScrollY(): number;
  /** Rendered height of every header track row, in px. */
  headerRowHeights(): number[];
  unmount(): void;
}

function toEntry(item: ContextMenuItem): MenuEntry {
  return {
    id: item.id,
    label: item.label ?? '',
    disabledReason: item.disabledReason ?? null,
  };
}

function findItem(items: readonly ContextMenuItem[], id: string): ContextMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.children ? findItem(item.children, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function stubBrowserSurfaces(): () => void {
  class FixedResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const contentRect = { width: VIEWPORT.widthPx, height: VIEWPORT.heightPx } as DOMRectReadOnly;
      this.callback([{ target, contentRect } as ResizeObserverEntry], this as never);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', FixedResizeObserver);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  return () => {
    getContext.mockRestore();
    vi.unstubAllGlobals();
  };
}

/** Dispatches a pointer-shaped event; jsdom has no PointerEvent constructor. */
function dispatchPointer(
  element: HTMLElement,
  type: 'pointerdown' | 'pointerup',
  clientX: number,
  clientY: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: 1 },
  });
  element.dispatchEvent(event);
}

/**
 * Creates a fresh project (default track and clip), runs `seed`, clears the
 * undo history so a spec can assert on what its own actions record, and
 * mounts ArrangementView attached to the document.
 */
export async function mountArrangementView(
  options: ArrangementViewMountOptions = {},
): Promise<ArrangementViewHarness> {
  setActivePinia(createPinia());
  const store = useProjectStore();
  store.dispose();
  clearHistory();
  clearAudioClipData();
  await store.init();
  await options.seed?.();
  clearHistory();

  const restoreSurfaces = stubBrowserSurfaces();
  const wrapper = mount(ArrangementView, {
    props: options.props ?? {},
    attachTo: document.body,
    global: { directives: { tooltip: vTooltip } },
  });
  await flushPromises();

  const canvas = () => wrapper.getComponent(ArrangementCanvas);
  const headers = () => wrapper.getComponent(TrackHeaderList);
  const canvasElement = () => canvas().get('.arrangement-canvas').element as HTMLElement;

  /** Viewport point (the canvas sits at the origin in jsdom) of a clip's lane at `ppq`. */
  function clipPoint(clipId: number, ppq: number): { x: number; y: number } {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) throw new Error(`no clip ${clipId}`);
    const { range, tracks, rowLayout, scrollY, laneHeight } = canvas().props();
    const index = tracks.findIndex((track) => track.id === clip.trackId);
    if (index < 0) throw new Error(`track of clip ${clipId} is not visible`);
    return {
      x: range.ppqToX(ppq),
      y: RULER_HEIGHT_PX + rowLayout.rowTop(index) - scrollY + laneHeight / 2,
    };
  }

  async function contextMenuAt(x: number, y: number): Promise<MenuEntry[]> {
    closeContextMenu();
    await canvas().get('.arrangement-canvas').trigger('contextmenu', { clientX: x, clientY: y });
    await flushPromises();
    const state = useContextMenuState();
    return state.open ? state.items.filter((item) => !item.separator).map(toEntry) : [];
  }

  async function focusNavigatorItem(clipId: number): Promise<void> {
    const listbox = canvas().get('[role="listbox"]');
    const ids = canvas()
      .findAll('[role="option"]')
      .map((option) => option.attributes('id') ?? '');
    const index = ids.findIndex((id) => id.endsWith(`-clip-${clipId}`));
    if (index < 0) throw new Error(`clip ${clipId} is not in the navigator`);
    await listbox.trigger('keydown', { key: 'Home' });
    for (let step = 0; step < index; step += 1) {
      await listbox.trigger('keydown', { key: 'ArrowDown' });
    }
  }

  return {
    wrapper,
    store,
    async openClipMenu(clipId, atPpq) {
      const clip = store.clips.find((entry) => entry.id === clipId);
      if (!clip) throw new Error(`no clip ${clipId}`);
      const point = clipPoint(clipId, atPpq ?? clip.startPpq + clip.lengthPpq / 2);
      return contextMenuAt(point.x, point.y);
    },
    async openRulerMenu(ppq) {
      return contextMenuAt(canvas().props().range.ppqToX(ppq), RULER_HEIGHT_PX / 2);
    },
    async runMenuItem(id) {
      const state = useContextMenuState();
      const item = state.open ? findItem(state.items, id) : undefined;
      if (!item?.run) throw new Error(`menu item ${id} is not open or has no action`);
      if (item.disabledReason) {
        throw new Error(`menu item ${id} is disabled: ${item.disabledReason}`);
      }
      closeContextMenu();
      await item.run();
      await flushPromises();
    },
    async answerPrompt(value) {
      await flushPromises();
      const request = dialogQueue[0];
      if (request?.kind !== 'prompt') throw new Error('no prompt is pending');
      resolveDialog(request.id, value);
      await flushPromises();
      return request;
    },
    async splitWithTool(clipId, ppq) {
      const element = canvasElement();
      element.setPointerCapture = () => {};
      const point = clipPoint(clipId, ppq);
      useEditorTool().setTool('split');
      try {
        dispatchPointer(element, 'pointerdown', point.x, point.y);
        dispatchPointer(element, 'pointerup', point.x, point.y);
      } finally {
        useEditorTool().setTool('select');
      }
      await flushPromises();
    },
    async pressClipKey(clipId, key, modifiers = {}) {
      await focusNavigatorItem(clipId);
      await canvas()
        .get('[role="listbox"]')
        .trigger('keydown', { key, ...modifiers });
      await flushPromises();
    },
    async setClipControl(clipId, control, value) {
      await focusNavigatorItem(clipId);
      const accessibility = en.shell.arrangement.accessibility;
      const label = control === 'start' ? accessibility.start : accessibility.length;
      const field = canvas()
        .findAll('.navigator-controls label')
        .find((entry) => entry.text().trim() === label);
      if (!field) throw new Error(`no ${control} control in the navigator`);
      await field.get('input').setValue(String(value));
      await flushPromises();
    },
    async wheel(target, init) {
      const element =
        target === 'headers' ? headers().element : wrapper.get('.cell-canvas').element;
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
      await flushPromises();
    },
    errorLine() {
      const line = wrapper.find('.arrangement-error');
      return line.exists() ? line.text() : '';
    },
    canvas,
    headers,
    headerScrollY() {
      const transform = (headers().get('.headers-rows').element as HTMLElement).style.transform;
      const match = transform.match(/translateY\((-?[\d.]+)px\)/);
      if (!match) throw new Error(`header rows are not translated: "${transform}"`);
      return 0 - Number(match[1]);
    },
    headerRowHeights() {
      return headers()
        .findAll('.track-row')
        .map((row) => Number.parseFloat((row.element as HTMLElement).style.height));
    },
    unmount() {
      wrapper.unmount();
      closeContextMenu();
      dialogQueue.splice(0);
      useEditorTool().setTool('select');
      restoreSurfaces();
    },
  };
}

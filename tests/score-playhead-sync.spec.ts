import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { VerovioTimemapEntry } from '@/notation/verovio';
import { usePlayheadSync } from '@/ui/score/use-playhead-sync';

function rect(left: number, right: number, top = 0, bottom = 10): DOMRect {
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function defineReadonlyNumber(el: HTMLElement, key: 'clientWidth' | 'scrollWidth', value: number) {
  Object.defineProperty(el, key, { configurable: true, value });
}

function makeSvgElement(id: string, className: string, bounds: DOMRect): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  el.setAttribute('id', id);
  el.setAttribute('class', className);
  el.getBoundingClientRect = vi.fn(() => bounds);
  return el;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('usePlayheadSync', () => {
  it('throttles score following while still updating note highlights', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const n1 = makeSvgElement('n1', 'note', rect(80, 90));
    const n2 = makeSvgElement('n2', 'note', rect(180, 190));
    host.append(n1, n2);

    const ppq = ref(0);
    const svg = ref('<svg />');
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(200).mockReturnValueOnce(240).mockReturnValue(400);
    const timemap: VerovioTimemapEntry[] = [
      { tstamp: 0, qstamp: 0, on: ['n1'] },
      { tstamp: 100, qstamp: 1, off: ['n1'], on: ['n2'] },
    ];

    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg,
        getTimemap: () => timemap,
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => ppq.value,
        getIsPlaying: () => true,
      });
    });

    await nextTick();
    expect(host.querySelectorAll('.score-playhead-marker')).toHaveLength(1);
    const firstScroll = host.scrollLeft;

    ppq.value = 1;
    await nextTick();
    expect(host.querySelectorAll('.score-playhead-marker')).toHaveLength(1);
    expect(host.scrollLeft).toBe(firstScroll);

    ppq.value = 1.1;
    await nextTick();
    expect(host.scrollLeft).toBeGreaterThan(firstScroll);

    scope.stop();
  });

  it('groups every simultaneous note in a chord into one marker', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const low = makeSvgElement('low', 'note', rect(80, 90, 36, 46));
    const high = makeSvgElement('high', 'note', rect(84, 96, 4, 14));
    host.append(low, high);

    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [{ tstamp: 0, qstamp: 0, on: ['low', 'high'] }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
      });
    });

    await nextTick();

    const markers = host.querySelectorAll<HTMLElement>('.score-playhead-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].dataset.noteIds?.split(' ').sort()).toEqual(['high', 'low']);
    expect(Number.parseFloat(markers[0].style.height)).toBeGreaterThan(40);

    scope.stop();
  });

  it('caches measured note bounds across backward seeks', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const n1 = makeSvgElement('n1', 'note', rect(180, 190));
    const n2 = makeSvgElement('n2', 'note', rect(260, 270));
    host.append(n1, n2);

    const ppq = ref(0);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1200).mockReturnValue(1400);
    const timemap: VerovioTimemapEntry[] = [
      { tstamp: 0, qstamp: 0, on: ['n1'] },
      { tstamp: 100, qstamp: 1, off: ['n1'], on: ['n2'] },
    ];

    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => timemap,
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => ppq.value,
        getIsPlaying: () => true,
      });
    });

    await nextTick();
    ppq.value = 1;
    await nextTick();
    ppq.value = 0;
    await nextTick();

    expect(n1.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(n2.getBoundingClientRect).toHaveBeenCalledTimes(1);

    scope.stop();
  });

  it('follows measure bounds before note bounds when measures are available', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const m1 = makeSvgElement('m1', 'measure', rect(170, 260));
    const n1 = makeSvgElement('n1', 'note', rect(180, 190));
    host.append(m1, n1);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [{ tstamp: 0, qstamp: 0, measureOn: 'm1', on: ['n1'] }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
        getIsPlaying: () => true,
      });
    });

    await nextTick();

    expect(m1.getBoundingClientRect).toHaveBeenCalled();
    expect(n1.getBoundingClientRect).not.toHaveBeenCalled(); // playback uses the measure marker
    expect(host.scrollLeft).toBeGreaterThan(0);

    scope.stop();
  });

  it('tints every note of the sounding harmony and untints them when they stop', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const low = makeSvgElement('low', 'note', rect(80, 90));
    const high = makeSvgElement('high', 'note', rect(82, 92));
    host.append(low, high);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const ppq = ref(0);
    const isPlaying = ref(true);

    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [
          { tstamp: 0, qstamp: 0, on: ['low', 'high'] },
          { tstamp: 100, qstamp: 1, off: ['low', 'high'] },
        ],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => ppq.value,
        getIsPlaying: () => isPlaying.value,
      });
    });

    await nextTick();
    expect(low.classList.contains('score-note-sounding')).toBe(true);
    expect(high.classList.contains('score-note-sounding')).toBe(true);

    ppq.value = 1;
    await nextTick();
    expect(low.classList.contains('score-note-sounding')).toBe(false);
    expect(high.classList.contains('score-note-sounding')).toBe(false);

    scope.stop();
  });

  it('does not tint notes while the transport is stopped', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));
    const n1 = makeSvgElement('n1', 'note', rect(80, 90));
    host.append(n1);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [{ tstamp: 0, qstamp: 0, on: ['n1'] }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
        getIsPlaying: () => false,
      });
    });

    await nextTick();
    expect(n1.classList.contains('score-note-sounding')).toBe(false);

    scope.stop();
  });

  it('re-highlights the newly rendered notes after the score re-renders', async () => {
    // Models a track switch mid-playback: the SVG (v-html) is replaced with a
    // different track's notes, the timemap swaps and the panel resets the scan.
    // The highlight must rebuild against the new elements, not keep stale ones.
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));
    host.append(makeSvgElement('a1', 'note', rect(300, 320)));

    const ppq = ref(0);
    const svg = ref('<svg>A</svg>');
    let timemap: VerovioTimemapEntry[] = [{ tstamp: 0, qstamp: 0, on: ['a1'] }];
    vi.spyOn(performance, 'now').mockReturnValue(1000);

    const scope = effectScope();
    const sync = scope.run(() =>
      usePlayheadSync({
        svgHost: ref(host),
        svg,
        getTimemap: () => timemap,
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => ppq.value,
        getIsPlaying: () => true,
      }),
    );

    await nextTick();
    let markers = host.querySelectorAll('.score-playhead-marker');
    expect(markers).toHaveLength(1);
    expect((markers[0] as HTMLElement).dataset.noteIds).toBe('a1');

    host.replaceChildren(makeSvgElement('b1', 'note', rect(600, 620)));
    timemap = [{ tstamp: 0, qstamp: 0, on: ['b1'] }];
    svg.value = '<svg>B</svg>';
    sync?.resetScan();
    ppq.value = 0.001;
    await nextTick();

    markers = host.querySelectorAll('.score-playhead-marker');
    expect(markers).toHaveLength(1);
    expect((markers[0] as HTMLElement).dataset.noteIds).toBe('b1');

    scope.stop();
  });

  it('keeps playback highlighting while score following is disabled', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const m1 = makeSvgElement('m1', 'measure', rect(180, 260));
    const n1 = makeSvgElement('n1', 'note', rect(190, 200));
    host.append(m1, n1);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [{ tstamp: 0, qstamp: 0, measureOn: 'm1', on: ['n1'] }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
        getIsPlaying: () => true,
        getFollowEnabled: () => false,
      });
    });

    await nextTick();

    const marker = host.querySelector('.score-playhead-marker');
    expect(marker?.classList.contains('score-playhead-marker-measure')).toBe(true);
    expect(host.scrollLeft).toBe(0);

    scope.stop();
  });

  it('uses one measure marker during playback', async () => {
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const m1 = makeSvgElement('m1', 'measure', rect(20, 120));
    const low = makeSvgElement('low', 'note', rect(30, 40));
    const high = makeSvgElement('high', 'note', rect(44, 56));
    host.append(m1, low, high);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg: ref('<svg />'),
        getTimemap: () => [{ tstamp: 0, qstamp: 0, measureOn: 'm1', on: ['low', 'high'] }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
        getIsPlaying: () => true,
      });
    });

    await nextTick();

    const markers = host.querySelectorAll('.score-playhead-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].classList.contains('score-playhead-marker-measure')).toBe(true);
    expect((markers[0] as HTMLElement).dataset.noteIds?.split(' ').sort()).toEqual(['high', 'low']);
    expect(m1.getBoundingClientRect).toHaveBeenCalled();
    expect(low.getBoundingClientRect).not.toHaveBeenCalled();
    expect(high.getBoundingClientRect).not.toHaveBeenCalled();

    scope.stop();
  });

  it('ignores pending idle measure prewarm after scope disposal', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    defineReadonlyNumber(host, 'clientWidth', 100);
    defineReadonlyNumber(host, 'scrollWidth', 1000);
    host.getBoundingClientRect = vi.fn(() => rect(0, 100));

    const measure = makeSvgElement('m1', 'measure', rect(10, 120));
    host.append(measure);
    const svg = ref('<svg />');

    const scope = effectScope();
    scope.run(() => {
      usePlayheadSync({
        svgHost: ref(host),
        svg,
        getTimemap: () => [{ tstamp: 0, qstamp: 0, measureOn: 'm1' }],
        getClipStartPpq: () => 0,
        getPositionPpq: () => () => 0,
      });
    });

    await nextTick();
    scope.stop();
    vi.runOnlyPendingTimers();

    expect(measure.getBoundingClientRect).not.toHaveBeenCalled();
  });
});

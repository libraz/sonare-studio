import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ChordLane from '@/components/arrangement/ChordLane.vue';
import { keyScaleToScaleHighlight } from '@/compose/key';
import { buildKeyMap } from '@/compose/key-map';
import { keyMarkerName } from '@/compose/key-name';
import type { EditorChordSymbol } from '@/project/chords';
import { type EditorMarker, MAJOR_MODE_MASK } from '@/project/types';
import { TimelineRange } from '@/ui/canvas/timeline-range';

const METER = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function chord(startPpq: number, endPpq: number, rootPc = 0, quality = 0): EditorChordSymbol {
  return { startPpq, endPpq, rootPc, quality };
}

function marker(partial: Partial<EditorMarker>): EditorMarker {
  return { id: 1, ppq: 0, name: 'Marker', ...partial };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ChordLane', () => {
  it('culls chords entirely outside the visible range', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(0, 4), chord(1000, 1004)],
        timeSignatures: METER,
      },
    });
    expect(wrapper.findAll('.chord-band')).toHaveLength(1);
  });

  it('shifts band positions by originPpq', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(100, 104)],
        timeSignatures: METER,
        originPpq: 100,
      },
    });
    expect(wrapper.get('.chord-band').attributes('style')).toContain('left: 0px');
  });

  it('emits seek with the chord absolute startPpq on click', async () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords: [chord(4, 8)], timeSignatures: METER },
    });
    await wrapper.get('.chord-band').trigger('click');
    expect(wrapper.emitted('seek')).toEqual([[4]]);
  });

  it('opens the chord list on double-click anywhere in the lane', async () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords: [], timeSignatures: METER },
    });
    await wrapper.get('.chord-lane').trigger('dblclick');
    expect(wrapper.emitted('openChords')).toHaveLength(1);
  });

  it('repeats the chord-name label at bar boundaries for a long chord', () => {
    const range = new TimelineRange({ widthPx: 2000, heightPx: 22, pxPerPpq: 5 });
    const wrapper = mount(ChordLane, {
      // 80 bars (320 ppq) at 4/4, comfortably wider than the 44px label
      // spacing guard, so more than the sticky first label should appear.
      props: { range, revision: 0, chords: [chord(0, 320)], timeSignatures: METER },
    });
    expect(wrapper.findAll('.chord-name').length).toBeGreaterThan(1);
  });

  it('shows the empty hint only when the host opts in with showHints', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const arrangementHost = mount(ChordLane, {
      props: { range, revision: 0, chords: [], timeSignatures: METER, showHints: true },
    });
    expect(arrangementHost.find('.chord-hint').exists()).toBe(true);

    const pianoRollHost = mount(ChordLane, {
      props: { range, revision: 0, chords: [], timeSignatures: METER },
    });
    expect(pianoRollHost.find('.chord-hint').exists()).toBe(false);
  });

  it('shows the tracks-still-empty hint once chords exist but hasContent is false', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(0, 4)],
        timeSignatures: METER,
        hasContent: false,
        showHints: true,
      },
    });
    expect(wrapper.find('.chord-hint').exists()).toBe(true);
  });

  it('hides the tracks-still-empty hint once content exists', () => {
    const range = new TimelineRange({ widthPx: 800, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(0, 4)],
        timeSignatures: METER,
        hasContent: true,
        showHints: true,
      },
    });
    expect(wrapper.find('.chord-hint').exists()).toBe(false);
  });

  it('pulses a newly-populated lane and clears the pulse after the timeout', async () => {
    vi.useFakeTimers();
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords: [], timeSignatures: METER },
    });

    await wrapper.setProps({ chords: [chord(0, 4)] });
    expect(wrapper.get('.chord-band').classes()).toContain('chord-band-flash');

    vi.advanceTimersByTime(1200);
    await nextTick();
    expect(wrapper.get('.chord-band').classes()).not.toContain('chord-band-flash');
  });

  it('spells a chord with the key-fifths of its own keyMap region', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const keyMap = buildKeyMap(
      keyScaleToScaleHighlight({ rootPc: 0, modeMask12: MAJOR_MODE_MASK }),
      [
        marker({ id: 1, ppq: 16, name: keyMarkerName(-3, false) }), // Eb major (3 flats)
      ],
    );
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        // F#/Gb (pitch class 6) in each region: sharp side before the marker
        // (0 fifths), flat side after it (-3 fifths).
        chords: [chord(0, 4, 6), chord(16, 20, 6)],
        timeSignatures: METER,
        keyFifths: 99, // ignored once keyMap is supplied
        keyMap,
      },
    });
    const names = wrapper.findAll('.chord-name').map((label) => label.text().replace(/\s.*/, ''));
    expect(names[0]).not.toBe(names[1]);
  });
});

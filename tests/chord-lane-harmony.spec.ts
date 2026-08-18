import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ChordLane from '@/components/arrangement/ChordLane.vue';
import type { EditorChordSymbol } from '@/project/chords';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { MESSAGES } from '@/ui/i18n';
import { vTooltip } from '@/ui/tooltip';

const METER = [{ startPpq: 0, numerator: 4, denominator: 4 }];

/** Editor quality ordinals used by the progressions below. */
const MAJOR = 0;
const MINOR = 1;
const DOM7 = 4;
const MAJ7 = 5;
const MIN7 = 6;

/** ii-V-I in C followed by ii-V-I in G, whose keys share four triads. */
const TO_THE_DOMINANT: ReadonlyArray<[number, number]> = [
  [2, MIN7],
  [7, DOM7],
  [0, MAJ7],
  [0, MAJ7],
  [9, MIN7],
  [2, DOM7],
  [7, MAJ7],
  [7, MAJ7],
];

/** ii-V-I in C followed by ii-V-I in Eb, one chord per bar. */
const MODULATING: ReadonlyArray<[number, number]> = [
  [2, MIN7],
  [7, DOM7],
  [0, MAJ7],
  [0, MAJ7],
  [5, MIN7],
  [10, DOM7],
  [3, MAJ7],
  [3, MAJ7],
];

function chord(startPpq: number, endPpq: number, rootPc = 0, quality = MAJOR): EditorChordSymbol {
  return { startPpq, endPpq, rootPc, quality };
}

function laneWith(chords: EditorChordSymbol[]) {
  const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
  return mount(ChordLane, { props: { range, revision: 0, chords, timeSignatures: METER } });
}

describe('ChordLane harmonic annotation', () => {
  it('writes the applied numeral beside a secondary dominant', () => {
    const wrapper = laneWith([chord(0, 4, 2, DOM7), chord(4, 8, 7)]);
    expect(wrapper.get('.chord-mark').text()).toBe('V7/V');
  });

  it('marks a borrowed chord and leaves diatonic chords unmarked', () => {
    const borrowed = laneWith([chord(0, 4, 5, MINOR)]);
    expect(borrowed.get('.chord-mark').text()).toBe('♭');

    const diatonic = laneWith([chord(0, 4, 5)]);
    expect(diatonic.find('.chord-mark').exists()).toBe(false);
  });

  it('draws a cadence marker where the cadence resolves', () => {
    const wrapper = laneWith([chord(0, 4, 7), chord(4, 8, 0)]);
    const marker = wrapper.get('.cadence-mark');
    expect(marker.attributes('style')).toContain('left: 40px');
    expect(marker.get('.cadence-label').text()).toBe(MESSAGES.en.harmony.cadence.short.authentic);
  });

  it('drops the cadence abbreviation when the approaching band is too narrow', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 2 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(0, 4, 7), chord(4, 8, 0)],
        timeSignatures: METER,
      },
    });
    expect(wrapper.find('.cadence-mark').exists()).toBe(true);
    expect(wrapper.find('.cadence-label').exists()).toBe(false);
  });

  it('reads the progression in the supplied key', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(0, 4, 5, MAJOR)],
        timeSignatures: METER,
        // C natural minor, where a major IV is borrowed from the parallel major.
        keyScale: { rootPc: 0, modeMask12: 0b0101_1010_1101 },
      },
    });
    expect(wrapper.get('.chord-mark').text()).toContain('♮');

    const inMajor = laneWith([chord(0, 4, 5, MAJOR)]);
    expect(inMajor.find('.chord-mark').exists()).toBe(false);
  });

  it('names the reading in the band tooltip without changing seek behaviour', async () => {
    const wrapper = laneWith([chord(0, 4, 7), chord(4, 8, 0)]);
    await wrapper.findAll('.chord-band')[1].trigger('click');
    expect(wrapper.emitted('seek')).toEqual([[4]]);
  });

  it('draws no key-span band on a progression that stays in one key', () => {
    const wrapper = laneWith([chord(0, 4, 7), chord(4, 8, 0)]);
    expect(wrapper.find('.key-span').exists()).toBe(false);
  });

  it('bands and names each key a modulating progression passes through', () => {
    const chords = MODULATING.map(([rootPc, quality], index) =>
      chord(index * 4, index * 4 + 4, rootPc, quality),
    );
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords, timeSignatures: METER },
    });
    const spans = wrapper.findAll('.key-span');
    expect(spans.length).toBe(2);
    expect(spans[0].attributes('style')).toContain('left: 0px');
    expect(spans[1].attributes('style')).toContain('left: 160px');
    const modes = MESSAGES.en.shell.lists.key.modes;
    expect(wrapper.findAll('.key-span-label').map((label) => label.text())).toEqual([
      `C ${modes.major}`,
      `Eb ${modes.major}`,
    ]);
  });

  /**
   * A key band already says the key changed; what it cannot say on its own is
   * how. The relation goes in the label and the chord the move turned on goes
   * in the tooltip, alongside the chords it could have turned on instead.
   */
  it('says how the key moved and which chord the move turned on', () => {
    const chords = TO_THE_DOMINANT.map(([rootPc, quality], index) =>
      chord(index * 4, index * 4 + 4, rootPc, quality),
    );
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords, timeSignatures: METER },
      global: { directives: { tooltip: vTooltip } },
    });

    const moves = wrapper.findAll('.key-span-move');
    // Only the span that was moved into has a move to report.
    expect(moves).toHaveLength(1);
    expect(moves[0].text()).toContain(MESSAGES.en.harmony.modulation.relation.dominant);

    const labels = wrapper.findAll('.key-span-label');
    expect(labels[0].classes()).not.toContain('key-span-moved');
    expect(labels[1].classes()).toContain('key-span-moved');
    // The tooltip directive publishes its text as the anchor's accessible name.
    const title = labels[1].attributes('aria-label') ?? '';
    expect(title).toContain('I = IV');
    // The alternatives are the other shared chords, never the one already used.
    expect(title).toContain('iii = vi');
    expect(title.match(/I = IV/g)).toHaveLength(1);
  });

  // Keys that share no triad cannot be turned on a chord, and the tooltip says
  // that rather than leaving the move unexplained.
  it('calls a move between keys that share no chord a direct one', () => {
    const chords = MODULATING.map(([rootPc, quality], index) =>
      chord(index * 4, index * 4 + 4, rootPc, quality),
    );
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords, timeSignatures: METER },
      global: { directives: { tooltip: vTooltip } },
    });

    const labels = wrapper.findAll('.key-span-label');
    expect(labels[1].attributes('aria-label')).toContain(MESSAGES.en.harmony.modulation.direct);
    // No named relation holds between C major and E flat major.
    expect(wrapper.findAll('.key-span-move')).toHaveLength(0);
  });

  it('drops the key name when the visible span is too narrow', () => {
    const chords = MODULATING.map(([rootPc, quality], index) =>
      chord(index * 4, index * 4 + 4, rootPc, quality),
    );
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 2 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords, timeSignatures: METER },
    });
    expect(wrapper.findAll('.key-span').length).toBe(2);
    expect(wrapper.findAll('.key-span-label').length).toBe(0);
  });

  it('shifts key-span bands by originPpq', () => {
    const chords = MODULATING.map(([rootPc, quality], index) =>
      chord(100 + index * 4, 104 + index * 4, rootPc, quality),
    );
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: { range, revision: 0, chords, timeSignatures: METER, originPpq: 100 },
    });
    expect(wrapper.findAll('.key-span')[1].attributes('style')).toContain('left: 160px');
  });

  it('shifts cadence markers by originPpq', () => {
    const range = new TimelineRange({ widthPx: 400, heightPx: 22, pxPerPpq: 10 });
    const wrapper = mount(ChordLane, {
      props: {
        range,
        revision: 0,
        chords: [chord(100, 104, 7), chord(104, 108, 0)],
        timeSignatures: METER,
        originPpq: 100,
      },
    });
    expect(wrapper.get('.cadence-mark').attributes('style')).toContain('left: 40px');
  });
});

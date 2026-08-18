import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TheoryCardView from '@/components/compose/TheoryCardView.vue';
import type { TheoryCard } from '@/compose/explain';

/**
 * The shared hover theory card: its glossary affordance and the hold signal the
 * hosts use to keep the card alive while that affordance is being reached for.
 */

function makeCard(over: Partial<TheoryCard> = {}): TheoryCard {
  return {
    title: 'C4',
    lines: [
      { label: 'Role', text: 'Chord tone' },
      {
        label: 'Tension',
        text: 'Leading tone',
        term: { term: 'Leading tone', definition: 'The seventh degree, pulling to the tonic.' },
      },
    ],
    ...over,
  };
}

describe('TheoryCardView', () => {
  it('carries the glossary affordance exactly on the lines that name a term', () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });

    const buttons = wrapper.findAll('.theory-card-info');
    expect(wrapper.findAll('.theory-card-line')).toHaveLength(2);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.attributes('aria-label')).toBe('Leading tone');
    expect(buttons[0]?.attributes('aria-expanded')).toBe('false');
  });

  it('expands and collapses the definition in place', async () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });
    const info = wrapper.get('.theory-card-info');

    await info.trigger('click');
    expect(wrapper.get('.theory-card-glossary').text()).toContain(
      'The seventh degree, pulling to the tonic.',
    );
    expect(info.attributes('aria-expanded')).toBe('true');
    expect(info.classes()).toContain('is-open');

    await info.trigger('click');
    expect(wrapper.find('.theory-card-glossary').exists()).toBe(false);
    expect(info.attributes('aria-expanded')).toBe('false');
  });

  it('collapses an open definition when a new card takes over', async () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });
    await wrapper.get('.theory-card-info').trigger('click');
    expect(wrapper.find('.theory-card-glossary').exists()).toBe(true);

    await wrapper.setProps({ card: makeCard({ title: 'E4' }) });

    expect(wrapper.get('.theory-card-title').text()).toBe('E4');
    expect(wrapper.find('.theory-card-glossary').exists()).toBe(false);
  });

  it('holds while the affordance has the pointer or focus, and releases once', async () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });
    const info = wrapper.get('.theory-card-info');

    await info.trigger('pointerenter');
    await info.trigger('focus');
    // Focus arriving on an already hovered button is the same hold, not a second one.
    expect(wrapper.emitted('hold')).toEqual([[true]]);

    await info.trigger('pointerleave');
    expect(wrapper.emitted('hold')).toEqual([[true]]);

    await info.trigger('blur');
    expect(wrapper.emitted('hold')).toEqual([[true], [false]]);
  });
});

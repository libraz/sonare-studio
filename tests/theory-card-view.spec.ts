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

  it('sets the provenance marker apart from the wording it qualifies', () => {
    const wrapper = mount(TheoryCardView, {
      props: {
        card: makeCard({
          lines: [
            { label: 'Scale', text: 'Degree 1', badge: 'inferred' },
            { label: 'Role', text: 'Chord tone' },
          ],
        }),
      },
    });

    const badges = wrapper.findAll('.theory-card-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.text()).toBe('inferred');
    // Inside the text span, so it wraps with the reading rather than being
    // pinned to the right of a line that has grown to two.
    const text = wrapper.findAll('.theory-card-text')[0];
    expect(text?.find('.theory-card-badge').exists()).toBe(true);
    expect(text?.text()).toBe('Degree 1inferred');
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

  it('holds while the card has the pointer or focus, and releases once outside', async () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });
    const card = wrapper.get('.theory-card');
    const info = wrapper.get('.theory-card-info');

    await card.trigger('pointerenter');
    await info.trigger('focusin');
    // Focus arriving on an already hovered card is the same hold, not a second one.
    expect(wrapper.emitted('hold')).toEqual([[true]]);

    await card.trigger('pointerleave');
    expect(wrapper.emitted('hold')).toEqual([[true]]);

    await card.trigger('focusout', { relatedTarget: null });
    expect(wrapper.emitted('hold')).toEqual([[true], [false]]);
  });

  it('keeps focus hold while focus moves between card controls', async () => {
    const wrapper = mount(TheoryCardView, { props: { card: makeCard() } });
    const card = wrapper.get('.theory-card');
    const info = wrapper.get('.theory-card-info');

    await info.trigger('focusin');
    await card.trigger('focusout', { relatedTarget: info.element });

    expect(wrapper.emitted('hold')).toEqual([[true]]);
    await card.trigger('focusout', { relatedTarget: null });
    expect(wrapper.emitted('hold')).toEqual([[true], [false]]);
  });
});

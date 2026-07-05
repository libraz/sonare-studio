import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ScoreAnnotationPalette from '@/components/score/ScoreAnnotationPalette.vue';

describe('ScoreAnnotationPalette', () => {
  it('renders ornament controls and emits ornament toggles', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: { ornament: 'trill' },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    const trill = buttons.find((button) => button.text() === 'Trill');
    const fermata = buttons.find((button) => button.text() === 'Fermata');
    expect(trill?.classes()).toContain('active');
    expect(fermata).toBeDefined();

    await trill?.trigger('click');
    await fermata?.trigger('click');

    expect(wrapper.emitted('apply')).toEqual([[{ ornament: null }], [{ ornament: 'fermata' }]]);
  });

  it('emits hairpin arm and clear actions', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: { hairpin: 'crescendo', hairpinToNoteId: 42 },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    await buttons.find((button) => button.text() === 'Cresc.')?.trigger('click');
    await buttons.find((button) => button.text() === 'No hairpin')?.trigger('click');

    expect(wrapper.emitted('hairpinArmedChange')).toEqual([['crescendo']]);
    expect(wrapper.emitted('apply')).toEqual([[{ hairpin: null }]]);
  });

  it('emits line span arm and clear actions', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: { lineSpan: 'glissando', lineSpanToNoteId: 42 },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    expect(buttons.find((button) => button.text() === '15ma')).toBeDefined();

    await buttons.find((button) => button.text() === 'Gliss.')?.trigger('click');
    await buttons.find((button) => button.text() === 'No span')?.trigger('click');

    expect(wrapper.emitted('lineSpanArmedChange')).toEqual([['glissando']]);
    expect(wrapper.emitted('apply')).toEqual([[{ lineSpan: null }]]);
  });

  it('emits pedal style changes', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: { lineSpan: 'pedal', lineSpanToNoteId: 42, pedalStyle: 'sign' },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    const pedalLine = buttons.find((button) => button.text() === 'Pedal line');
    const pedalSign = buttons.find((button) => button.text() === 'Ped. *');
    expect(pedalSign?.classes()).toContain('active');

    await pedalLine?.trigger('click');
    await pedalSign?.trigger('click');

    expect(wrapper.emitted('apply')).toEqual([[{ pedalStyle: 'line' }], [{ pedalStyle: 'sign' }]]);
  });

  it('emits glissando style and text changes', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: {
          lineSpan: 'glissando',
          lineSpanToNoteId: 42,
          glissandoLineType: 'dashed',
          glissandoText: 'slide',
        },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    expect(buttons.find((button) => button.text() === 'Dashed')?.classes()).toContain('active');
    await buttons.find((button) => button.text() === 'Wavy')?.trigger('click');

    const input = wrapper.find('input.palette-text');
    await input.setValue('slide up');

    expect(wrapper.emitted('apply')).toEqual([
      [{ glissandoLineType: 'wavy' }],
      [{ glissandoText: 'slide up' }],
    ]);
  });

  it('emits staff override toggles', async () => {
    const wrapper = mount(ScoreAnnotationPalette, {
      props: {
        annotation: { staffOverride: 1 },
        position: { x: 12, y: 24 },
        slurArmed: false,
        hairpinArmed: null,
        lineSpanArmed: null,
      },
      global: {
        directives: {
          tooltip: () => undefined,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    const upper = buttons.find((button) => button.text() === 'Upper staff');
    const lower = buttons.find((button) => button.text() === 'Lower staff');
    expect(upper?.classes()).toContain('active');

    await upper?.trigger('click');
    await lower?.trigger('click');

    expect(wrapper.emitted('apply')).toEqual([[{ staffOverride: null }], [{ staffOverride: 2 }]]);
  });
});

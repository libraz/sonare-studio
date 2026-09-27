import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import GuidanceLegend from '@/components/piano-roll/GuidanceLegend.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { vRadioGroup } from '@/ui/accessibility/radiogroup';
import { MESSAGES } from '@/ui/i18n';

const roll = MESSAGES.en.shell.pianoRoll;
const profileName = MESSAGES.en.settings.general.guidanceProfileName;

function mountLegend() {
  return mount(GuidanceLegend, { global: { directives: { radiogroup: vRadioGroup } } });
}

describe('GuidanceLegend', () => {
  beforeEach(() => {
    useAppSettings().reset();
  });

  it('explains the three placement levels, the hatch, the dotted underline and the resolution arrow', () => {
    const text = mountLegend().text();
    for (const line of [
      roll.guidePlacementSafe,
      roll.guidePlacementWarn,
      roll.guidePlacementNg,
      roll.guidePlacementThinned,
      roll.guidePlacementResolution,
    ]) {
      expect(text).toContain(line);
    }
  });

  it('draws the ng swatch with a hatch rather than colour alone', () => {
    const wrapper = mountLegend();
    expect(wrapper.find('[data-legend="placement-ng"] line').exists()).toBe(true);
    expect(
      wrapper.find('[data-legend="placement-thinned"] line').attributes('stroke-dasharray'),
    ).toBeTruthy();
    expect(
      wrapper.find('[data-legend="placement-resolution"] line').attributes('stroke-dasharray'),
    ).toBeTruthy();
  });

  it('switches the shared guidance profile', async () => {
    const wrapper = mountLegend();
    const group = wrapper.get(`[role="radiogroup"][aria-label="${roll.guideProfile}"]`);
    const radios = group.findAll('[role="radio"]');
    expect(radios.map((radio) => radio.text())).toEqual([
      profileName.counterpoint,
      profileName.pop,
    ]);
    expect(radios[1].attributes('aria-checked')).toBe('true');

    await radios[0].trigger('click');
    expect(useAppSettings().settings.guidanceProfile).toBe('counterpoint');
    expect(radios[0].attributes('aria-checked')).toBe('true');
  });

  it('says avoid-note rows turn red on every beat only under counterpoint', async () => {
    const wrapper = mountLegend();
    useAppSettings().set('guidanceProfile', 'counterpoint');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain(roll.guideAvoidNoteCounterpoint);

    useAppSettings().set('guidanceProfile', 'pop');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain(roll.guideAvoidNoteCounterpoint);
  });
});

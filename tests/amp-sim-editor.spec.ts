import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AmpSimEditor from '@/components/devices/AmpSimEditor.vue';
import { insertAutomationParam } from '@/project/automation';
import { addInsert, clearHistory, undo } from '@/project/commands';
import { getWasmModule, useProjectStore } from '@/project/store';
import { resetAutomationStripModes, setAutomationStripMode } from '@/ui/mixer/automation-mode';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('AmpSimEditor.vue', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    addInsert(trackId, 'saturation.ampSim', { presetIndex: 0 });
    resetAutomationStripModes();
  });

  it('offers all portable amp presets and stores their numeric index', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const presets = wrapper.findAll('.amp-preset');
    expect(presets).toHaveLength(10);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0);
    expect(presets[0].attributes('aria-pressed')).toBe('true');

    await presets[5].trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params.presetIndex).toBe(5);
    expect(wrapper.find('.amp-preset.selected').text()).toContain('Modern Lead');
    expect(presets[5].attributes('aria-pressed')).toBe('true');

    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.inserts[0].params.presetIndex).toBe(0);
  });

  it('writes tone and cab changes through the insert command path', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const bass = wrapper.find('input[aria-label="Bass"]');
    await bass.setValue('6');
    expect(store.tracks[0].mixer?.inserts[0].params.bassDb).toBe(6);

    await wrapper.find('.amp-cab-actions button:last-child').trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params.cab).toBe(false);
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.inserts[0].params.cab).toBeUndefined();
  });

  it('shows inherited values until a parameter is explicitly overridden', () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    expect(wrapper.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.25');
    expect(wrapper.find('output').text()).toBe('0.25');
    const bass = wrapper.find('input[aria-label="Bass"]');
    expect(bass.attributes('type')).toBe('range');
    expect(bass.element).toHaveProperty('value', '2');
    expect(bass.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.amp-control-source').text()).toBe('Preset');
    expect(wrapper.find('.amp-custom-hint').exists()).toBe(false);
    expect(wrapper.find('.amp-cab-actions button:first-child').attributes('aria-pressed')).toBe(
      'true',
    );
    expect(wrapper.find('.amp-cab-actions button:last-child').attributes('aria-pressed')).toBe(
      'false',
    );
  });

  it('edits an inherited slider without expanding the sparse project params', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    await wrapper.find('input[aria-label="Bass"]').setValue('6');

    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({
      presetIndex: 0,
      bassDb: 6,
    });
    expect(wrapper.find('output').text()).toContain('0.25');
    expect(wrapper.find('input[aria-label="Bass"]').element).toHaveProperty('value', '6');
  });

  it('shows the selected preset values for tone, model, and cabinet inheritance', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    await wrapper.findAll('.amp-preset')[5].trigger('click');

    expect(wrapper.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.8');
    expect(wrapper.find('input[aria-label="Middle"]').element).toHaveProperty('value', '-3');
    expect(wrapper.findAll('.amp-advanced select')[0].element).toHaveProperty('value', '2');
    expect(wrapper.find('.amp-cab-actions button:first-child').attributes('aria-pressed')).toBe(
      'true',
    );
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 5 });
  });

  it('uses authoritative normal defaults for custom and unknown preset slots', () => {
    const customIndex = addInsert(trackId, 'saturation.ampSim', {});
    const custom = mount(AmpSimEditor, { props: { trackId, insertIndex: customIndex } });
    expect(custom.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.5');
    expect(custom.findAll('.amp-advanced select')[0].element).toHaveProperty('value', '0');
    expect(custom.find('.amp-cab-actions button:first-child').attributes('aria-pressed')).toBe(
      'true',
    );
    expect(store.tracks[0].mixer?.inserts[customIndex].params).toEqual({});

    const unknownIndex = addInsert(trackId, 'saturation.ampSim', { presetIndex: 99 });
    const unknown = mount(AmpSimEditor, { props: { trackId, insertIndex: unknownIndex } });
    expect(unknown.find('input[aria-label="Drive"]').element).toHaveProperty('value', '0.5');
    expect(unknown.findAll('.amp-advanced select')[0].element).toHaveProperty('value', '0');
    expect(custom.find('.amp-control-source').text()).toBe('Default');
    expect(unknown.find('.amp-control-source').text()).toBe('Default');
  });

  it('does not expose normal defaults when the preset catalog is unavailable', () => {
    const wasm = getWasmModule() as unknown as {
      masteringAmpPresetCatalog: () => unknown;
    };
    const originalCatalog = wasm.masteringAmpPresetCatalog;
    wasm.masteringAmpPresetCatalog = () => [];
    try {
      const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
      const drive = wrapper.find('input[aria-label="Drive"]');
      expect(drive.attributes('disabled')).toBeDefined();
      expect(wrapper.find('.amp-control output').text()).toBe('—');
      expect(wrapper.find('.amp-sim-catalog-error').text()).toContain(
        'Preset values are unavailable',
      );

      const customIndex = addInsert(trackId, 'saturation.ampSim', {});
      const custom = mount(AmpSimEditor, { props: { trackId, insertIndex: customIndex } });
      const customDrive = custom.find('input[aria-label="Drive"]');
      expect(customDrive.attributes('disabled')).toBeUndefined();
      expect(customDrive.element).toHaveProperty('value', '0.5');
      expect(custom.find('.amp-control-source').text()).toBe('Default');
      expect(custom.find('.amp-sim-catalog-error').exists()).toBe(false);
    } finally {
      wasm.masteringAmpPresetCatalog = originalCatalog;
    }
  });

  it('uses the inherited cabinet state and writes a single override when changed', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    await wrapper.findAll('.amp-preset')[8].trigger('click');

    expect(wrapper.find('.amp-cab-actions button:last-child').attributes('aria-pressed')).toBe(
      'true',
    );
    await wrapper.find('.amp-cab-actions button:first-child').trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 8, cab: true });
  });

  it('keeps the amp header bypass control synchronized with the insert row state', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const bypass = wrapper.find('.amp-bypass');

    expect(bypass.attributes('aria-pressed')).toBe('false');
    expect(bypass.attributes('aria-label')).toBe('Bypass insert');
    await bypass.trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].enabled).toBe(false);
    expect(bypass.attributes('aria-pressed')).toBe('true');
    expect(bypass.attributes('aria-label')).toBe('Bypass insert');

    await bypass.trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].enabled).toBe(true);
    expect(bypass.attributes('aria-pressed')).toBe('false');
  });

  it('clears the previous rig overrides with one preset edit', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    await wrapper.find('input[aria-label="Bass"]').setValue('6');
    expect(wrapper.find('.amp-custom-hint').text()).toContain('Preset adjusted');
    expect(wrapper.find('input[aria-label="Bass"]').attributes('type')).toBe('range');
    await wrapper.find('.amp-cab-actions button:last-child').trigger('click');
    const previous = { ...store.tracks[0].mixer?.inserts[0].params };

    await wrapper.findAll('.amp-preset')[5].trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 5 });
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual(previous);
  });

  it('resets an adjusted rig when its already selected preset is clicked again', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    await wrapper.find('input[aria-label="Bass"]').setValue('6');
    await wrapper.findAll('.amp-preset')[0].trigger('click');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 0 });
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 0, bassDb: 6 });
  });

  it('offers advanced amp, cabinet, and microphone models without inventing inherited values', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const model = wrapper.findAll('.amp-advanced select')[0];
    expect(model.element).toHaveProperty('value', '1');
    await model.setValue('2');
    await wrapper.find('input[aria-label="Mic distance (cm)"]').setValue('8');
    expect(store.tracks[0].mixer?.inserts[0].params).toMatchObject({
      presetIndex: 0,
      ampModel: 2,
      micDistanceCm: 8,
    });
  });

  it('shows normalized construction values with enough precision for editing', () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const power = wrapper.find('input[aria-label="Power stage"]').element.closest('.amp-control');
    const sag = wrapper.find('input[aria-label="Supply sag"]').element.closest('.amp-control');
    expect(power?.querySelector('output')?.textContent).toBe('0.15');
    expect(sag?.querySelector('output')?.textContent).toBe('0.07');
  });

  it('defers construction-only microphone distance writes until the range changes', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const distance = wrapper.find('input[aria-label="Mic distance (cm)"]');
    const input = distance.element as HTMLInputElement;
    input.value = '8';
    await distance.trigger('input');

    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 0 });
    expect(input.value).toBe('8');
    expect(distance.element.closest('.amp-control')?.querySelector('output')?.textContent).toBe(
      '8.0',
    );

    await distance.trigger('change');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({
      presetIndex: 0,
      micDistanceCm: 8,
    });
  });

  it('cancels a construction-only drag without writing or leaving a draft value', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const distance = wrapper.find('input[aria-label="Mic distance (cm)"]');
    const input = distance.element as HTMLInputElement;
    input.value = '8';
    await distance.trigger('input');
    await distance.trigger('pointercancel');
    await wrapper.vm.$nextTick();

    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 0 });
    expect(input.value).toBe('3');
    expect(distance.element.closest('.amp-control')?.querySelector('output')?.textContent).toBe(
      '3.0',
    );
  });

  it('clears a pending construction value when selecting another amp preset', async () => {
    const wrapper = mount(AmpSimEditor, { props: { trackId, insertIndex: 0 } });
    const distance = wrapper.find('input[aria-label="Mic distance (cm)"]');
    const input = distance.element as HTMLInputElement;
    input.value = '8';
    await distance.trigger('input');
    await wrapper.findAll('.amp-preset')[5].trigger('click');
    await wrapper.vm.$nextTick();

    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 5 });
    expect(input.value).toBe('2.5');
    expect(distance.element.closest('.amp-control')?.querySelector('output')?.textContent).toBe(
      '2.5',
    );
  });

  it.each(['touch', 'latch'] as const)(
    'writes realtime amp range changes to a %s automation lane without changing params',
    async (mode) => {
      setAutomationStripMode(trackId, mode);
      const scheduled: unknown[] = [];
      const wrapper = mount(AmpSimEditor, {
        props: {
          trackId,
          insertIndex: 0,
          positionPpq: () => 8,
          positionSample: () => 1024,
          isPlaying: true,
          scheduleAutomationWrite: (...args: unknown[]) => scheduled.push(args),
        },
      });
      const drive = wrapper.find('input[aria-label="Drive"]');
      const input = drive.element as HTMLInputElement;
      input.value = '0.8';
      await drive.trigger('input');

      const insert = store.tracks[0].mixer?.inserts[0];
      const param = insertAutomationParam(insert?.id ?? 0, 'drive');
      expect(insert?.params.drive).toBeUndefined();
      expect(input.value).toBe('0.8');
      expect(drive.element.closest('.amp-control')?.querySelector('output')?.textContent).toBe(
        '0.80',
      );

      await drive.trigger('change');
      await wrapper.vm.$nextTick();

      const lane = store.automationLanes.find(
        (entry) => entry.target === trackId && entry.param === param,
      );
      expect(lane?.points.length).toBeGreaterThan(0);
      expect(insert?.params.drive).toBeUndefined();
      expect(scheduled).toEqual([
        [trackId, param, expect.objectContaining({ ppq: 8, samplePos: 1024, value: 0.8 })],
      ]);
    },
  );

  it('keeps construction-only mic distance on the static command path in write mode', async () => {
    setAutomationStripMode(trackId, 'touch');
    const wrapper = mount(AmpSimEditor, {
      props: { trackId, insertIndex: 0, positionPpq: () => 8, isPlaying: true },
    });
    const distance = wrapper.find('input[aria-label="Mic distance (cm)"]');
    const input = distance.element as HTMLInputElement;
    input.value = '8';
    await distance.trigger('input');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ presetIndex: 0 });

    await distance.trigger('change');
    expect(store.tracks[0].mixer?.inserts[0].params).toEqual({
      presetIndex: 0,
      micDistanceCm: 8,
    });
    expect(store.automationLanes).toHaveLength(0);
  });
});

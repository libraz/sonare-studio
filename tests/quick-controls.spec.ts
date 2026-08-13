import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addInsert, clearHistory, setTrackInstrument, undo } from '@/project/commands';
import { listQuickControls, setQuickControl } from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('quick controls', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  describe('listQuickControls (instrument)', () => {
    it('exposes the primary synth fields with ranges and units', () => {
      const controls = listQuickControls({ type: 'instrument', trackId });
      expect(controls.map((c) => c.id)).toEqual([
        'cutoffHz',
        'resonanceQ',
        'drive',
        'ampAttackMs',
        'ampDecayMs',
        'ampSustain',
        'ampReleaseMs',
        'gain',
      ]);
      const cutoff = controls.find((c) => c.id === 'cutoffHz');
      expect(cutoff).toMatchObject({ name: 'Cutoff', min: 20, max: 20000, unit: 'Hz' });
      const sustain = controls.find((c) => c.id === 'ampSustain');
      expect(sustain?.unit).toBeUndefined();
    });

    it('resolves preset base values through the resolver seam', () => {
      const resolvePresetPatch = vi.fn(() => ({ cutoffHz: 1234, gain: 0.5 }));
      const controls = listQuickControls({ type: 'instrument', trackId }, { resolvePresetPatch });
      expect(resolvePresetPatch).toHaveBeenCalledWith('e-piano');
      expect(controls.find((c) => c.id === 'cutoffHz')?.value).toBe(1234);
      expect(controls.find((c) => c.id === 'gain')?.value).toBe(0.5);
      // Unresolved fields fall back to the documented defaults.
      expect(controls.find((c) => c.id === 'ampSustain')?.value).toBe(0.7);
    });

    it('prefers explicit patch fields over the preset base', () => {
      setTrackInstrument(trackId, {
        kind: 'synth-patch',
        patch: { preset: 'saw-lead', cutoffHz: 444 },
      });
      const resolvePresetPatch = vi.fn(() => ({ cutoffHz: 9999, drive: 0.9 }));
      const controls = listQuickControls({ type: 'instrument', trackId }, { resolvePresetPatch });
      expect(resolvePresetPatch).toHaveBeenCalledWith('saw-lead');
      expect(controls.find((c) => c.id === 'cutoffHz')?.value).toBe(444);
      expect(controls.find((c) => c.id === 'drive')?.value).toBe(0.9);
    });

    it('displays the encoded zero sustain override as zero', () => {
      setTrackInstrument(trackId, {
        kind: 'synth-patch',
        patch: { preset: 'saw-lead', ampSustain: 0.0001 },
      });
      const controls = listQuickControls(
        { type: 'instrument', trackId },
        { resolvePresetPatch: () => ({ ampSustain: 0.7 }) },
      );
      expect(controls.find((c) => c.id === 'ampSustain')?.value).toBe(0);
    });

    it('prioritizes amp and body controls for guitar and bass presets', () => {
      setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'electric-guitar' });
      const controls = listQuickControls(
        { type: 'instrument', trackId },
        { resolvePresetPatch: () => ({ bodyMix: 0.45, busDrive: 0.25, gain: 0.7 }) },
      );
      expect(controls.map((c) => c.id)).toEqual([
        'drive',
        'bodyMix',
        'busDrive',
        'gain',
        'cutoffHz',
        'resonanceQ',
        'ampAttackMs',
        'ampReleaseMs',
      ]);
      expect(controls.find((c) => c.id === 'bodyMix')).toMatchObject({
        name: 'Body',
        value: 0.45,
      });
      expect(controls.find((c) => c.id === 'busDrive')).toMatchObject({
        name: 'Amp Drive',
        value: 0.25,
      });
    });

    it('does not classify bassoon as a plucked bass preset', () => {
      setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'Bassoon' });
      const controls = listQuickControls(
        { type: 'instrument', trackId },
        { resolvePresetPatch: () => ({ bodyMix: 0.45, busDrive: 0.25, gain: 0.7 }) },
      );
      expect(controls.map((c) => c.id)).toEqual([
        'cutoffHz',
        'resonanceQ',
        'drive',
        'ampAttackMs',
        'ampDecayMs',
        'ampSustain',
        'ampReleaseMs',
        'gain',
      ]);
      expect(controls.find((c) => c.id === 'bodyMix')).toBeUndefined();
      expect(controls.find((c) => c.id === 'busDrive')).toBeUndefined();
    });

    it('uses the wasm preset catalog by default (fake module)', () => {
      // fakeSynthPresetPatch reports cutoffHz 12000 for every known preset.
      const controls = listQuickControls({ type: 'instrument', trackId });
      expect(controls.find((c) => c.id === 'cutoffHz')?.value).toBe(12000);
    });

    it('returns no controls for SF2 instruments', () => {
      setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm' });
      expect(listQuickControls({ type: 'instrument', trackId })).toEqual([]);
    });

    it('throws for unknown tracks', () => {
      expect(() => listQuickControls({ type: 'instrument', trackId: 9999 })).toThrow(RangeError);
    });
  });

  describe('listQuickControls (insert)', () => {
    it('maps catalog params with name-convention ranges', () => {
      addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18 });
      const controls = listQuickControls({ type: 'insert', trackId, index: 0 });
      expect(controls.map((c) => c.id)).toEqual([
        'thresholdDb',
        'ratio',
        'attackMs',
        'releaseMs',
        'kneeDb',
        'makeupGainDb',
        'autoMakeup',
        'detector',
        'sidechainHpfEnabled',
      ]);
      expect(controls[0]).toMatchObject({
        name: 'Threshold Db',
        value: -18,
        min: -60,
        max: 0,
        unit: 'dB',
      });
      expect(controls.find((c) => c.id === 'ratio')).toMatchObject({ min: 1, max: 20, value: 4 });
      expect(controls.find((c) => c.id === 'attackMs')).toMatchObject({
        min: 0,
        max: 200,
        unit: 'ms',
        value: 10,
        defaultValue: 10,
      });
      expect(controls.find((c) => c.id === 'autoMakeup')).toMatchObject({
        kind: 'boolean',
        value: false,
        defaultValue: false,
      });
      expect(controls.find((c) => c.id === 'detector')).toMatchObject({
        kind: 'enum',
        value: 1,
        options: [
          { value: 0, label: 'Peak' },
          { value: 1, label: 'RMS' },
          { value: 2, label: 'Log RMS' },
        ],
      });
      expect(controls.find((c) => c.id === 'sidechainHpfEnabled')).toMatchObject({
        kind: 'boolean',
        value: false,
      });
    });

    it('uses the explicit catalog for indexed EQ booleans and enums', () => {
      addInsert(trackId, 'eq.parametric', {
        'band0.enabled': true,
        'band0.type': 5,
      });
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        { resolveInsertParams: () => ['band0.enabled', 'band0.type'] },
      );

      expect(controls).toEqual([
        expect.objectContaining({ kind: 'boolean', id: 'band0.enabled', value: true }),
        expect.objectContaining({
          kind: 'enum',
          id: 'band0.type',
          value: 5,
          options: expect.arrayContaining([{ value: 5, label: 'Band Pass' }]),
        }),
      ]);
    });

    it('falls back to explicitly set params for unknown processors', () => {
      addInsert(trackId, 'custom.unknown', { mix: 0.4, depthMs: 12 });
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        { resolveInsertParams: () => [] },
      );
      expect(controls.map((c) => c.id).sort()).toEqual(['depthMs', 'mix']);
      expect(controls.find((c) => c.id === 'mix')).toMatchObject({ min: 0, max: 1, value: 0.4 });
    });

    it('uses the modulation-rate domain and engine-provided unit metadata', () => {
      addInsert(trackId, 'modulation.chorus', { rateHz: 0.8 });
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        {
          resolveInsertParams: () => ['rateHz'],
          resolveInsertParamInfo: () => [{ name: 'rateHz', unit: 'Hz' }],
        },
      );

      expect(controls).toEqual([
        expect.objectContaining({ id: 'rateHz', value: 0.8, min: 0, max: 10, unit: 'Hz' }),
      ]);
    });

    it('infers the Q-factor range only for a real Q parameter', () => {
      addInsert(trackId, 'custom.filter');
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        { resolveInsertParams: () => ['resonanceQ', 'q'] },
      );
      expect(controls.find((c) => c.id === 'resonanceQ')).toMatchObject({
        min: 0.1,
        max: 18,
        scale: 'log',
      });
      expect(controls.find((c) => c.id === 'q')).toMatchObject({ min: 0.1, max: 18, scale: 'log' });
    });

    it('does not misread a param merely starting with q as a Q factor', () => {
      addInsert(trackId, 'custom.weird');
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        { resolveInsertParams: () => ['quantize', 'quality'] },
      );
      // Falls back to the normalized [0, 1] amount range, not the Q range.
      expect(controls.find((c) => c.id === 'quantize')).toMatchObject({ min: 0, max: 1 });
      expect(controls.find((c) => c.id === 'quality')).toMatchObject({ min: 0, max: 1 });
    });

    it('exposes every catalog and explicitly saved parameter', () => {
      const names = Array.from({ length: 12 }, (_, i) => `param${i}`);
      addInsert(trackId, 'custom.many', { savedParam: 0.75 });
      const controls = listQuickControls(
        { type: 'insert', trackId, index: 0 },
        { resolveInsertParams: () => names },
      );
      expect(controls.map((control) => control.id)).toEqual([...names, 'savedParam']);
    });

    it('addresses master inserts too', () => {
      addInsert('master', 'eq.tilt');
      const controls = listQuickControls({ type: 'insert', trackId: 'master', index: 0 });
      expect(controls.map((c) => c.id)).toEqual(['tiltDb', 'pivotHz']);
    });

    it('throws for unknown insert indices', () => {
      expect(() => listQuickControls({ type: 'insert', trackId, index: 0 })).toThrow(RangeError);
    });
  });

  describe('setQuickControl', () => {
    it('promotes a preset instrument to a patch keeping the preset base', () => {
      setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 800);
      expect(store.tracks[0].instrument).toEqual({
        kind: 'synth-patch',
        patch: { preset: 'e-piano', cutoffHz: 800 },
      });
    });

    it('merges into an existing patch and clamps to the range', () => {
      setTrackInstrument(trackId, { kind: 'synth-patch', patch: { drive: 0.2 } });
      setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 99999);
      expect(store.tracks[0].instrument).toEqual({
        kind: 'synth-patch',
        patch: { drive: 0.2, cutoffHz: 20000 },
      });
    });

    it('sets zero sustain as an explicit near-silent patch override', () => {
      setQuickControl({ type: 'instrument', trackId }, 'ampSustain', 0);
      expect(store.tracks[0].instrument).toEqual({
        kind: 'synth-patch',
        patch: { preset: 'e-piano', ampSustain: 0.0001 },
      });
    });

    it('routes insert edits through setInsertParam with clamping', () => {
      addInsert(trackId, 'dynamics.compressor');
      setQuickControl({ type: 'insert', trackId, index: 0 }, 'thresholdDb', -200);
      expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBe(-60);
      setQuickControl({ type: 'insert', trackId, index: 0 }, 'attackMs', 900);
      expect(store.tracks[0].mixer?.inserts[0].params.attackMs).toBe(200);
    });

    it('writes typed processor controls and rejects invalid values', () => {
      addInsert(trackId, 'dynamics.compressor');

      setQuickControl({ type: 'insert', trackId, index: 0 }, 'autoMakeup', true);
      setQuickControl({ type: 'insert', trackId, index: 0 }, 'detector', 2);
      setQuickControl({ type: 'insert', trackId, index: 0 }, 'sidechainHpfEnabled', true);

      expect(store.tracks[0].mixer?.inserts[0].params).toMatchObject({
        autoMakeup: true,
        detector: 2,
        sidechainHpfEnabled: true,
      });
      expect(() => setQuickControl({ type: 'insert', trackId, index: 0 }, 'autoMakeup', 1)).toThrow(
        RangeError,
      );
      expect(() => setQuickControl({ type: 'insert', trackId, index: 0 }, 'detector', 3)).toThrow(
        RangeError,
      );
    });

    it('does not clamp an un-catalogued processor parameter to a display heuristic', () => {
      addInsert(trackId, 'custom.tremolo', { rateHz: 0.8 });

      setQuickControl({ type: 'insert', trackId, index: 0 }, 'rateHz', 2);

      expect(store.tracks[0].mixer?.inserts[0].params.rateHz).toBe(2);
    });

    it('coalesces a knob drag into one undo step', () => {
      setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 400, { commit: false });
      setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 600, { commit: false });
      setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 800);
      expect((store.tracks[0].instrument as { patch: { cutoffHz?: number } }).patch.cutoffHz).toBe(
        800,
      );
      expect(undo()).toBe(true);
      expect(store.tracks[0].instrument).toBeUndefined();
      expect(undo()).toBe(false);
    });

    it('rejects unknown controls, sf2 targets and non-finite values', () => {
      expect(() => setQuickControl({ type: 'instrument', trackId }, 'nope', 1)).toThrow(RangeError);
      expect(() =>
        setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', Number.NaN),
      ).toThrow(RangeError);
      setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm' });
      expect(() => setQuickControl({ type: 'instrument', trackId }, 'cutoffHz', 100)).toThrow(
        RangeError,
      );
    });
  });
});

import { describe, expect, it } from 'vitest';
import { type ExportStageLabels, formatExportStage } from '@/export/export-stage';

const LABELS: ExportStageLabels = {
  preflight: 'preflight',
  render: 'rendering',
  encode: 'encoding',
  prepare: 'preparing engine',
  metering: 'analysing loudness',
  finalizing: 'finalising',
  mastering: 'mastering: {name}',
  masteringPreset: 'mastering preset: {name}',
  renderStem: 'rendering stem {index}',
  renderBusStem: 'rendering bus stem {index}',
  encodeStem: 'encoding stem {index}/{total}',
};

describe('formatExportStage', () => {
  it('maps plain lifecycle codes to their labels', () => {
    expect(formatExportStage('preflight', LABELS)).toBe('preflight');
    expect(formatExportStage('render', LABELS)).toBe('rendering');
    expect(formatExportStage('engine.render', LABELS)).toBe('rendering');
    expect(formatExportStage('encode', LABELS)).toBe('encoding');
    expect(formatExportStage('engine.prepare', LABELS)).toBe('preparing engine');
    expect(formatExportStage('metering', LABELS)).toBe('analysing loudness');
    expect(formatExportStage('done', LABELS)).toBe('finalising');
    expect(formatExportStage('', LABELS)).toBe('');
  });

  it('interpolates parameterized stem and mastering codes', () => {
    expect(formatExportStage('encode:stem:1/4', LABELS)).toBe('encoding stem 1/4');
    expect(formatExportStage('engine.stem:3', LABELS)).toBe('rendering stem 4');
    expect(formatExportStage('engine.busStem:2', LABELS)).toBe('rendering bus stem 3');
    expect(formatExportStage('engine.sf2:0', LABELS)).toBe('rendering stem 1');
    expect(formatExportStage('mastering.preset:warm', LABELS)).toBe('mastering preset: warm');
    expect(formatExportStage('mastering.limiter', LABELS)).toBe('mastering: limiter');
  });

  it('falls through to the raw code for unrecognized stages', () => {
    // An unexpected code must never blank the ticker; show it verbatim.
    expect(formatExportStage('clip:0:0', LABELS)).toBe('clip:0:0');
    expect(formatExportStage('encode:stem:bad', LABELS)).toBe('encode:stem:bad');
  });
});

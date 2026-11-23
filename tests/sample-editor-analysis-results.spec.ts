import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SampleEditorAnalysisResults from '@/components/sample-editor/SampleEditorAnalysisResults.vue';
import type {
  AcousticAnalysisSummary,
  RoomEstimateSummary,
} from '@/ui/sample-editor/room-acoustics';

const ROOM: RoomEstimateSummary = {
  volume: 1283,
  length: 10.9,
  width: 10.9,
  height: 10.9,
  drrDb: -13.3,
  confidence: 1,
  rt60Mid: 1.734,
  absorptionMean: 0.2,
};

const ACOUSTIC: AcousticAnalysisSummary = {
  kind: 'blind',
  rt60: 1.67,
  edt: 1.2,
  c50: -3.25,
  c80: 1.04,
  d50: 0.321,
  confidence: 0.98,
  rt60Mean: 1.6,
  edtMean: 1.1,
  isBlind: true,
};

function mountResults(room: RoomEstimateSummary | null, acoustic: AcousticAnalysisSummary | null) {
  return mount(SampleEditorAnalysisResults, {
    props: {
      repairAnalysis: null,
      repairStageChecked: {},
      repairStagesBlocked: null,
      applyRepairBlocked: null,
      matchEqAnalysis: null,
      matchEqCurvePoints: '',
      roomEstimate: room,
      acousticAnalysis: acoustic,
    },
    global: { directives: { tooltip: () => {} }, stubs: { ToggleButton: true } },
  });
}

/** The value cells of every result term list, whitespace-collapsed. */
function values(wrapper: ReturnType<typeof mountResults>): string[] {
  return wrapper.findAll('.room-estimate-grid dd').map((dd) => dd.text().replace(/\s+/g, ' '));
}

describe('SampleEditorAnalysisResults measure cells', () => {
  it('prints measured values with their units', () => {
    expect(values(mountResults(ROOM, ACOUSTIC))).toEqual([
      '10.9 × 10.9 × 10.9 m',
      '1283 m³',
      '1.73 s',
      '-13.3 dB',
      '1.67 s',
      '1.20 s',
      'C50 -3.3 dB / C80 1.0 dB',
      '32%',
    ]);
  });

  it('shows an unmeasured value as a bare dash, without a unit', () => {
    const room = { ...ROOM, volume: Number.NaN, rt60Mid: Number.NaN, drrDb: Number.NaN };
    const acoustic = {
      ...ACOUSTIC,
      rt60: Number.NaN,
      edt: Number.NaN,
      c50: Number.NaN,
      c80: Number.POSITIVE_INFINITY,
      d50: Number.NaN,
    };
    expect(values(mountResults(room, acoustic))).toEqual([
      '10.9 × 10.9 × 10.9 m',
      '—',
      '—',
      '—',
      '—',
      '—',
      'C50 — / C80 —',
      '—',
    ]);
  });
});

import type { MasteringRepairAnalysis } from '@libraz/libsonare';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SampleEditorAnalysisResults from '@/components/sample-editor/SampleEditorAnalysisResults.vue';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
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
  kind: 'impulse',
  rt60: 1.67,
  edt: 1.2,
  c50: -3.25,
  c80: 1.04,
  d50: 0.321,
  confidence: 0.98,
  rt60Mean: 1.6,
  edtMean: 1.1,
  isBlind: false,
};

function mountResults(
  room: RoomEstimateSummary | null,
  acoustic: AcousticAnalysisSummary | null,
  matchEqAnalysis: MatchEqAnalysis | null = null,
  repairAnalysis: MasteringRepairAnalysis | null = null,
) {
  return mount(SampleEditorAnalysisResults, {
    props: {
      repairAnalysis,
      repairStageChecked: {},
      repairStagesBlocked: null,
      applyRepairBlocked: null,
      matchEqAnalysis,
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

  it('labels unmeasured RT60 and preserves infinite measurements', () => {
    const room: RoomEstimateSummary = { confidence: 0, drrDb: Number.POSITIVE_INFINITY };
    const acoustic = {
      kind: 'blind' as const,
      confidence: 0,
      isBlind: true,
    };
    expect(values(mountResults(room, acoustic))).toEqual([
      '—',
      '—',
      'Not measured',
      '∞ dB',
      'Not measured',
      '—',
      'C50 — / C80 —',
      '—',
    ]);
  });

  it('keeps silent bands and loudness separate from absent measurements and gain', () => {
    const matchEq: MatchEqAnalysis = {
      curve: { frequencies: [], gainDb: [] },
      tonalBalance: [
        {
          lowHz: 100,
          highHz: 200,
          sourceDb: Number.NEGATIVE_INFINITY,
          referenceDb: -12,
          deviationDb: Number.NEGATIVE_INFINITY,
        },
        { lowHz: 200, highHz: 300, sourceDb: -12, referenceDb: Number.NEGATIVE_INFINITY },
      ],
      loudness: { sourceLufs: Number.NEGATIVE_INFINITY, referenceLufs: -18 },
    };
    const wrapper = mountResults(null, null, matchEq);

    expect(wrapper.findAll('.match-eq-band-db').map((item) => item.text())).toEqual(['-∞ dB', '—']);
    const loudness = wrapper.find('.match-eq-loudness').text();
    expect(loudness).toContain('-∞ → -18.0 LUFS');
    expect(loudness).not.toContain('undefined');
    expect(loudness).not.toContain('dB)');
  });

  it('shows measured repair silence as negative infinity', () => {
    const repair: MasteringRepairAnalysis = {
      declipThresholdSafe: true,
      integratedLufs: Number.NEGATIVE_INFINITY,
      recommended: [],
      explanation: [],
    };
    const wrapper = mountResults(null, null, null, repair);

    expect(wrapper.find('.repair-analysis .match-eq-loudness').text()).toBe('-∞ LUFS');
  });
});

import type {
  AnalyzeImpulseResponseRequest,
  AutoTuneRequest,
  DetectAcousticRequest,
  DetectOnsetsRequest,
  EstimateRoomRequest,
  EstimateTuningRequest,
  HarmonicRequest,
  MasterAudioRequest,
  MasterAudioStereoRequest,
  MasteringAnalyzePairRequest,
  MasteringApplyPairProcessorRequest,
  MasteringRepairAnalyzeRequest,
  MasteringRepairApplyRequest,
  MasteringRepairDeclickRequest,
  MasteringRepairDeclickStereoRequest,
  MasteringRepairDeclipRequest,
  MasteringRepairDenoiseClassicalRequest,
  MasteringRepairDenoiseClassicalStereoRequest,
  MasteringRepairTrimSilenceRequest,
  NoteMoveRequest,
  NoteSegmentsRequest,
  NoteStretchRequest,
  PitchCorrectTimevaryingRequest,
  PitchCorrectToMidiRequest,
  PitchPyinRequest,
  PitchShiftRequest,
  PitchYinRequest,
  RirDiagnostic,
  RoomMorphRequest,
  RoomMorphStereoRequest,
  SpectralEditRequest,
  SplitSilenceRequest,
  SynthesizeRirRequest,
  TimeStretchRequest,
  VoiceChangeRequest,
} from '@libraz/libsonare';
import * as core from '@libraz/libsonare';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeImpulseResponseRange,
  analyzeMatchEqToReference,
  analyzeRepairRange,
  autoTuneRange,
  declickRange,
  declipRange,
  decrackleRange,
  dehumRange,
  denoiseRange,
  dereverbRange,
  detectAcousticRange,
  detectNoteRegions,
  detectOnsetFrames,
  estimateRoomRange,
  estimateSourceMidi,
  harmonicRange,
  loadSampleEditorWasm,
  matchEqToReference,
  noteMoveRange,
  noteStretchRange,
  percussiveRange,
  pitchCorrectRange,
  pitchCorrectTimevaryingRange,
  pitchShiftRange,
  repairStagesRange,
  restoreRange,
  roomEstimateHasGeometry,
  roomEstimateToPreset,
  roomMorphChannels,
  type SampleEditorWasmOps,
  scaleCorrectRange,
  spectralDenoiseRange,
  spectralEditRange,
  splitSilenceFrames,
  synthesizeRirChannels,
  timeStretchRange,
  trimSilenceRange,
  tuneToReferenceRange,
  voiceChangeRange,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';
import { coreWasmBinary } from './core-package';
import {
  acousticResult,
  analyzeImpulseResponseFn,
  analyzePairFn,
  applyPairProcessorFn,
  autoTuneFn,
  autoTuneResult,
  declickFn,
  declickResult,
  declickStereoResult,
  declipFn,
  declipResult,
  decrackleFn,
  decrackleResult,
  dehumFn,
  dehumResult,
  denoiseClassicalFn,
  denoiseResult,
  denoiseStereoResult,
  dereverbClassicalFn,
  dereverbResult,
  detectAcousticFn,
  detectOnsetsFn,
  estimateRoomFn,
  estimateTuningFn,
  harmonicFn,
  masterAudioFn,
  masteringChainResult,
  masteringChainStereoResult,
  masteringResult,
  noteMoveFn,
  noteSegment,
  noteStretchFn,
  pairAnalysisResults,
  percussiveFn,
  pitchCorrectTimevaryingFn,
  pitchCorrectToMidiFn,
  pitchPyinFn,
  pitchResult,
  pitchShiftFn,
  pitchYinFn,
  repairAnalysis,
  repairApplyResult,
  rirResult,
  roomEstimateResult,
  roomMorphFn,
  roomMorphResult,
  roomMorphStereoResult,
  spectralEditFn,
  splitSilenceFn,
  timeStretchFn,
  trimSilenceFn,
  trimSilenceResult,
  voiceChangeFn,
} from './fakes/analysis';

const { ensureWasmMock } = vi.hoisted(() => ({ ensureWasmMock: vi.fn() }));
vi.mock('@/lib/wasm', () => ({ ensureWasm: ensureWasmMock }));

/** Shorthand: plain number arrays to planar Float32Array channels. */
function ch(...channels: number[][]): Float32Array[] {
  return channels.map((c) => new Float32Array(c));
}

/** Shorthand: planar channels back to plain number arrays. */
function plain(channels: ReadonlyArray<Float32Array>): number[][] {
  return channels.map((c) => [...c]);
}

beforeEach(() => {
  ensureWasmMock.mockReset();
});

describe('wasmOpAvailability', () => {
  it('reports all false for a missing module', () => {
    expect(wasmOpAvailability(null)).toEqual({
      pitchShift: false,
      pitchCorrect: false,
      pitchCorrectTimevarying: false,
      tuneReference: false,
      scaleCorrect: false,
      autoTune: false,
      voiceChange: false,
      harmonic: false,
      percussive: false,
      timeStretch: false,
      noteStretch: false,
      noteMove: false,
      detectNotes: false,
      declick: false,
      denoise: false,
      restore: false,
      declip: false,
      decrackle: false,
      dehum: false,
      dereverb: false,
      trimSilence: false,
      repairSession: false,
      detectOnsets: false,
      splitSilence: false,
      matchEq: false,
      matchEqAnalyze: false,
      roomMorph: false,
      roomMorphStereo: false,
      synthesizeRir: false,
      estimateRoom: false,
      analyzeImpulseResponse: false,
      detectAcoustic: false,
      spectralEdit: false,
    });
    expect(wasmOpAvailability(undefined).pitchShift).toBe(false);
  });

  it('reports per-function availability', () => {
    const mod: SampleEditorWasmOps = {
      pitchShift: pitchShiftFn((request) => request.samples),
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples),
      pitchYin: pitchYinFn(() => pitchResult({ medianF0: 440 })),
      masteringRepairDeclick: declickFn((request) => declickResult(request.samples)),
      masteringRepairDeclip: declipFn((request) => declipResult(request.samples)),
      masteringRepairDehum: dehumFn((request) => dehumResult(request.samples)),
      detectOnsets: detectOnsetsFn(() => new Float32Array()),
      splitSilence: splitSilenceFn(() => new Int32Array()),
      masteringApplyPairProcessor: applyPairProcessorFn(({ source }) => masteringResult(source)),
      analyzeImpulseResponse: analyzeImpulseResponseFn(() => acousticResult()),
      detectAcoustic: detectAcousticFn(() => acousticResult({ isBlind: true })),
    };
    expect(wasmOpAvailability(mod)).toEqual({
      pitchShift: true,
      pitchCorrect: true,
      pitchCorrectTimevarying: false,
      // Needs estimateTuning + pitchShift; estimateTuning is absent here.
      tuneReference: false,
      // Needs pitchYin + scaleQuantizeMidi + pitchCorrectToMidi; only the last is present.
      scaleCorrect: false,
      autoTune: false,
      voiceChange: false,
      harmonic: false,
      percussive: false,
      timeStretch: false,
      noteStretch: false,
      noteMove: false,
      detectNotes: false,
      declick: true,
      denoise: false,
      restore: false,
      declip: true,
      decrackle: false,
      dehum: true,
      dereverb: false,
      trimSilence: false,
      repairSession: false,
      detectOnsets: true,
      splitSilence: true,
      matchEq: true,
      // masteringPairAnalyze is absent in this module.
      matchEqAnalyze: false,
      // roomMorph is absent in this module.
      roomMorph: false,
      roomMorphStereo: false,
      synthesizeRir: false,
      estimateRoom: false,
      analyzeImpulseResponse: true,
      detectAcoustic: true,
      spectralEdit: false,
    });
  });

  it('reports scaleCorrect only with the full pitch+quantize+correct trio', () => {
    const full: SampleEditorWasmOps = {
      pitchYin: pitchYinFn(() => pitchResult({ medianF0: 440 })),
      scaleQuantizeMidi: (_root, _mask, midi) => midi,
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples),
    };
    expect(wasmOpAvailability(full).scaleCorrect).toBe(true);
    expect(
      wasmOpAvailability({ pitchYin: pitchYinFn(() => pitchResult({ medianF0: 440 })) })
        .scaleCorrect,
    ).toBe(false);
  });

  it('reports tuneReference only with both estimateTuning and pitchShift', () => {
    const both: SampleEditorWasmOps = {
      estimateTuning: () => 0,
      pitchShift: pitchShiftFn((request) => request.samples),
    };
    expect(wasmOpAvailability(both).tuneReference).toBe(true);
    expect(wasmOpAvailability({ estimateTuning: () => 0 }).tuneReference).toBe(false);
    expect(
      wasmOpAvailability({ pitchShift: pitchShiftFn((request) => request.samples) }).tuneReference,
    ).toBe(false);
  });
});

describe('matchEqToReference', () => {
  it('matches each channel against the same mono reference over the range', () => {
    const reference = new Float32Array([0.5, 0.25]);
    const masteringApplyPairProcessor = vi.fn((request: MasteringApplyPairProcessorRequest) => {
      expect(request.processor).toBe('match.applyMatchEq');
      expect([...request.reference]).toEqual([0.5, 0.25]);
      expect(request.sampleRate).toBe(48000);
      // Return a recognizable transform: scale the source by 2.
      return masteringResult(request.source.map((v) => v * 2));
    });
    const out = matchEqToReference(
      { masteringApplyPairProcessor: applyPairProcessorFn(masteringApplyPairProcessor) },
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      48000,
      reference,
      {
        startFrame: 1,
        endFrame: 3,
      },
    );
    expect(plain(out)).toEqual([
      [1, 4, 6, 4],
      [5, 12, 14, 8],
    ]);
    expect(masteringApplyPairProcessor).toHaveBeenCalledTimes(2);
  });

  it('defaults to the whole file without a range', () => {
    const masteringApplyPairProcessor = vi.fn((request: MasteringApplyPairProcessorRequest) =>
      masteringResult(request.source.map((v) => -v)),
    );
    const out = matchEqToReference(
      { masteringApplyPairProcessor: applyPairProcessorFn(masteringApplyPairProcessor) },
      ch([1, 2]),
      48000,
      new Float32Array([1]),
    );
    expect(plain(out)).toEqual([[-1, -2]]);
  });

  it('blends the matched signal back toward the dry segment for amount < 1', () => {
    // applyMatchEq doubles the source; abCrossfade linearly mixes a -> b by mix.
    const masteringApplyPairProcessor = vi.fn((request: MasteringApplyPairProcessorRequest) => {
      if (request.processor === 'match.applyMatchEq') {
        return masteringResult(request.source.map((v) => v * 2));
      }
      expect(request.processor).toBe('match.abCrossfade');
      const mix = Number(request.params?.mix ?? 0);
      return masteringResult(
        request.source.map((v, i) => v * (1 - mix) + request.reference[i] * mix),
      );
    });
    const out = matchEqToReference(
      { masteringApplyPairProcessor: applyPairProcessorFn(masteringApplyPairProcessor) },
      ch([1, 2]),
      48000,
      new Float32Array([1]),
      null,
      0.5,
    );
    // dry [1, 2], matched [2, 4], blended 50/50 -> [1.5, 3].
    expect(plain(out)).toEqual([[1.5, 3]]);
    expect(masteringApplyPairProcessor).toHaveBeenCalledWith({
      processor: 'match.abCrossfade',
      source: expect.anything(),
      reference: expect.anything(),
      sampleRate: 48000,
      params: { mix: 0.5 },
    });
  });

  it('returns the dry segment without matching when amount is 0', () => {
    const masteringApplyPairProcessor = vi.fn((request: MasteringApplyPairProcessorRequest) =>
      masteringResult(request.source.map((v) => v * 2)),
    );
    const out = matchEqToReference(
      { masteringApplyPairProcessor: applyPairProcessorFn(masteringApplyPairProcessor) },
      ch([1, 2]),
      48000,
      new Float32Array([1]),
      null,
      0,
    );
    expect(plain(out)).toEqual([[1, 2]]);
    expect(masteringApplyPairProcessor).not.toHaveBeenCalled();
  });

  it('hands the reference and its rate to the library unresampled', () => {
    const reference = Float32Array.from({ length: 441 }, (_, index) => index);
    const masteringApplyPairProcessor = vi.fn((request: MasteringApplyPairProcessorRequest) =>
      masteringResult(request.source.slice()),
    );

    matchEqToReference(
      { masteringApplyPairProcessor: applyPairProcessorFn(masteringApplyPairProcessor) },
      ch([1, 2]),
      48000,
      reference,
      null,
      1,
      44100,
    );

    expect(masteringApplyPairProcessor).toHaveBeenCalledOnce();
    const request = masteringApplyPairProcessor.mock.calls[0][0];
    expect(request.reference).toBe(reference);
    expect(request.sampleRate).toBe(48000);
    expect(request.referenceSampleRate).toBe(44100);
  });

  it('throws when unavailable, a sample rate is invalid, or the reference is empty', () => {
    expect(() => matchEqToReference({}, ch([1]), 48000, new Float32Array([1]))).toThrow(
      /unavailable/,
    );
    const mod: SampleEditorWasmOps = {
      masteringApplyPairProcessor: applyPairProcessorFn(({ source }) => masteringResult(source)),
    };
    expect(() => matchEqToReference(mod, ch([1]), 0, new Float32Array([1]))).toThrow(RangeError);
    expect(() =>
      matchEqToReference(mod, ch([1]), 48000, new Float32Array([1]), null, 1, 0),
    ).toThrow(RangeError);
    expect(() => matchEqToReference(mod, ch([1]), 48000, new Float32Array())).toThrow(/empty/);
  });
});

describe('analyzeMatchEqToReference', () => {
  it('downmixes the range to mono and reads the three analyses', () => {
    const reference = new Float32Array([0.5, 0.25]);
    const masteringAnalyzePair = vi.fn((request: MasteringAnalyzePairRequest) => {
      // The source is the channel average over the [1, 3) range: (2+6)/2, (3+7)/2.
      expect([...request.source]).toEqual([4, 5]);
      expect([...request.reference]).toEqual([0.5, 0.25]);
      expect(request.sampleRate).toBe(48000);
    });
    const results = pairAnalysisResults({
      'match.matchEqCurve': { frequencies: [100, 1000], gainDb: [1, -1] },
      'match.tonalBalance': {
        bands: [{ lowHz: 20, highHz: 200, sourceDb: -10, referenceDb: -12, deviationDb: 2 }],
      },
      'match.referenceLoudness': { sourceLufs: -14, referenceLufs: -9, gainToMatchDb: 5 },
    });
    const analysis = analyzeMatchEqToReference(
      { masteringAnalyzePair: analyzePairFn(results, masteringAnalyzePair) },
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      48000,
      reference,
      { startFrame: 1, endFrame: 3 },
    );
    expect(analysis.curve).toEqual({ frequencies: [100, 1000], gainDb: [1, -1] });
    expect(analysis.tonalBalance).toEqual([
      { lowHz: 20, highHz: 200, sourceDb: -10, referenceDb: -12, deviationDb: 2 },
    ]);
    expect(analysis.loudness).toEqual({ sourceLufs: -14, referenceLufs: -9, gainToMatchDb: 5 });
    expect(masteringAnalyzePair).toHaveBeenCalledTimes(3);
  });

  it('hands the reference and its rate to every pair analysis unresampled', () => {
    const reference = Float32Array.from({ length: 480 }, (_, index) => index);
    const masteringAnalyzePair = vi.fn<(request: MasteringAnalyzePairRequest) => void>();

    analyzeMatchEqToReference(
      {
        masteringAnalyzePair: analyzePairFn(
          pairAnalysisResults({
            'match.referenceLoudness': { sourceLufs: -12, referenceLufs: -12, gainToMatchDb: 0 },
          }),
          masteringAnalyzePair,
        ),
      },
      ch([1, 2]),
      44100,
      reference,
      null,
      48000,
    );

    expect(masteringAnalyzePair).toHaveBeenCalledTimes(3);
    for (const [request] of masteringAnalyzePair.mock.calls) {
      expect(request.reference).toBe(reference);
      expect(request.sampleRate).toBe(44100);
      expect(request.referenceSampleRate).toBe(48000);
    }
  });

  it('throws when unavailable, the sample rate is invalid, the reference is empty, or the range is empty', () => {
    expect(() => analyzeMatchEqToReference({}, ch([1]), 48000, new Float32Array([1]))).toThrow(
      /unavailable/,
    );
    const mod: SampleEditorWasmOps = { masteringAnalyzePair: analyzePairFn(pairAnalysisResults()) };
    expect(() => analyzeMatchEqToReference(mod, ch([1]), 0, new Float32Array([1]))).toThrow(
      RangeError,
    );
    expect(() => analyzeMatchEqToReference(mod, ch([1]), 48000, new Float32Array())).toThrow(
      /empty/,
    );
    expect(() =>
      analyzeMatchEqToReference(mod, ch([1, 2]), 48000, new Float32Array([1]), {
        startFrame: 1,
        endFrame: 1,
      }),
    ).toThrow(/empty range/);
  });
});

describe('detectOnsetFrames', () => {
  it('downmixes to mono and converts onset seconds to sorted frames', () => {
    const detectOnsets = vi.fn((request: DetectOnsetsRequest) => {
      // The detector should receive the channel average over 8 frames.
      expect([...request.samples]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
      return new Float32Array([0.5, 0.1]); // seconds -> 4, 0 frames at 8 Hz... see below
    });
    const left = new Float32Array([2, 0, 0, 0, 0, 0, 0, 0]);
    const right = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
    // sampleRate 8: 0.5 s -> frame 4, 0.1 s -> frame 1 (round). Sorted ascending.
    expect(
      detectOnsetFrames({ detectOnsets: detectOnsetsFn(detectOnsets) }, [left, right], 8),
    ).toEqual([1, 4]);
    expect(detectOnsets).toHaveBeenCalledTimes(1);
  });

  it('throws when detectOnsets is unavailable or the sample rate is invalid', () => {
    expect(() => detectOnsetFrames({}, [new Float32Array([1])], 48000)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { detectOnsets: () => new Float32Array() };
    expect(() => detectOnsetFrames(mod, [new Float32Array([1])], 0)).toThrow(RangeError);
  });
});

describe('detectNoteRegions', () => {
  /** A contour whose flags say voiced everywhere but whose prob never reaches 0.5. */
  const contour = pitchResult({
    f0: new Float32Array([220, 220, 262, 262]),
    voicedProb: new Float32Array([0.44, 0.42, 0.43, 0.41]),
    voicedFlag: [true, true, true, false],
    medianF0: 240,
  });

  it('tracks the mono downmix and cuts it into notes at the measured settings', () => {
    const pitchPyin = vi.fn((request: PitchPyinRequest) => {
      const { samples, sampleRate, ...options } = request;
      expect([...samples]).toEqual([0.5, 0.5]);
      expect(sampleRate).toBe(48000);
      // The frequency range and threshold are left to the library: clamping
      // the range mistracks the octave of anything outside the clamp.
      expect(options).toEqual({ frameLength: 2048, hopLength: 512, fillNa: true });
      return contour;
    });
    const noteSegments = vi.fn((request: NoteSegmentsRequest) => {
      expect(request.frameRate).toBeCloseTo(48000 / 512, 6);
      // Voicing comes from the tracker's own decision. Its confidence peaks
      // below the 0.5 the segmenter treats as voiced, so forwarding it would
      // discard every frame.
      expect([...(request.voicedProb ?? [])]).toEqual([1, 1, 1, 0]);
      return [
        noteSegment({ frameStart: 0, frameEnd: 2, startSec: 0, endSec: 0.5, medianCents: -900 }),
        noteSegment({ frameStart: 2, frameEnd: 4, startSec: 0.5, endSec: 1, medianCents: -600 }),
      ];
    });

    const notes = detectNoteRegions(
      { pitchPyin: pitchPyinFn(pitchPyin), noteSegments },
      ch([1, 0], [0, 1]),
      48000,
    );

    // Cents are relative to the segmenter's A440 reference: -900 is C4, -600 Eb4.
    // The second region starts past this 2-frame buffer, so it drops out.
    expect(notes).toEqual([{ startFrame: 0, endFrame: 2, midi: 60 }]);
    expect(noteSegments.mock.calls[0]?.[0]).toMatchObject({ segmentationThresholdCents: 80 });
  });

  it('converts the median pitch of each region from cents to a MIDI number', () => {
    const pitchPyin = () => contour;
    const noteSegments = () => [
      noteSegment({ frameStart: 0, frameEnd: 1, startSec: 0, endSec: 1, medianCents: -900 }),
      noteSegment({ frameStart: 1, frameEnd: 2, startSec: 1, endSec: 2, medianCents: 0 }),
      noteSegment({ frameStart: 2, frameEnd: 3, startSec: 2, endSec: 3, medianCents: 350 }),
    ];
    expect(
      detectNoteRegions({ pitchPyin, noteSegments }, ch(new Array(3).fill(0)), 1).map(
        (note) => note.midi,
      ),
    ).toEqual([60, 69, 72.5]);
  });

  it('clamps a region to the buffer and drops one that ends up empty', () => {
    const pitchPyin = () => contour;
    const noteSegments = () => [
      noteSegment({ frameStart: 0, frameEnd: 1, startSec: -1, endSec: 0.5, medianCents: 0 }),
      noteSegment({ frameStart: 1, frameEnd: 2, startSec: 8, endSec: 9, medianCents: 0 }),
    ];
    // 4 frames at 8 Hz is 0.5 s of audio, so the first note clamps to [0, 4)
    // and the second starts past the end.
    expect(detectNoteRegions({ pitchPyin, noteSegments }, ch([0, 0, 0, 0]), 8)).toEqual([
      { startFrame: 0, endFrame: 4, midi: 69 },
    ]);
  });

  it('falls back to pitchYin and reports an unusable contour as no notes', () => {
    const noteSegments = vi.fn(() => []);
    const pitchYin = vi.fn(() => contour);
    expect(detectNoteRegions({ pitchYin, noteSegments }, ch([1, 1]), 48000)).toEqual([]);
    expect(pitchYin).toHaveBeenCalledTimes(1);

    const short = pitchResult({
      f0: new Float32Array([220]),
      voicedFlag: [true, true],
      medianF0: 220,
    });
    expect(detectNoteRegions({ pitchYin: () => short, noteSegments }, ch([1, 1]), 48000)).toEqual(
      [],
    );
    expect(
      detectNoteRegions({ pitchYin: () => pitchResult(), noteSegments }, ch([1, 1]), 48000),
    ).toEqual([]);
    // Nothing reached the segmenter for either unusable contour.
    expect(noteSegments).toHaveBeenCalledTimes(1);
  });

  it('throws without a tracker, without a segmenter, or on a bad sample rate', () => {
    const contourOnly: SampleEditorWasmOps = { pitchPyin: () => contour };
    expect(() => detectNoteRegions(contourOnly, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => detectNoteRegions({ noteSegments: () => [] }, ch([1]), 48000)).toThrow(
      /unavailable/,
    );
    expect(() =>
      detectNoteRegions({ pitchPyin: () => contour, noteSegments: () => [] }, ch([1]), 0),
    ).toThrow(RangeError);
  });
});

describe('noteMoveRange', () => {
  it('moves the selected region to the shifted onset on every channel', () => {
    const noteMove = vi.fn((request: NoteMoveRequest) => {
      const { samples, sampleRate, ...options } = request;
      expect(sampleRate).toBe(48000);
      expect(options).toEqual({ onsetSample: 2, offsetSample: 4, targetOnsetSample: 3 });
      return samples.map((value) => value + 1);
    });
    const out = noteMoveRange(
      { noteMove: noteMoveFn(noteMove) },
      ch([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]),
      48000,
      1,
      {
        startFrame: 2,
        endFrame: 4,
      },
    );
    expect(plain(out)).toEqual([
      [2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13],
    ]);
    expect(noteMove).toHaveBeenCalledTimes(2);
  });

  it('clamps the target so the note stays inside the buffer', () => {
    const targets: number[] = [];
    const noteMove = noteMoveFn((request) => {
      targets.push(request.targetOnsetSample ?? -1);
      return request.samples;
    });
    const channels = ch([1, 2, 3, 4, 5, 6]);
    // A 2-frame note in a 6-frame buffer can start no later than frame 4.
    noteMoveRange({ noteMove }, channels, 48000, 100, { startFrame: 2, endFrame: 4 });
    noteMoveRange({ noteMove }, channels, 48000, -100, { startFrame: 2, endFrame: 4 });
    expect(targets).toEqual([4, 0]);
  });

  it('rounds a fractional shift and defaults to the whole file', () => {
    const noteMove = vi.fn((request: NoteMoveRequest) => request.samples);
    noteMoveRange({ noteMove: noteMoveFn(noteMove) }, ch([1, 2, 3, 4]), 48000, 0.6);
    expect(noteMove).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 48000,
      onsetSample: 0,
      offsetSample: 4,
      targetOnsetSample: 0,
    });
  });

  it('throws when noteMove is unavailable, the shift is not finite, or the range is empty', () => {
    expect(() => noteMoveRange({}, ch([1]), 48000, 1)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { noteMove: noteMoveFn((request) => request.samples) };
    expect(() => noteMoveRange(mod, ch([1]), 48000, Number.NaN)).toThrow(RangeError);
    expect(() => noteMoveRange(mod, ch([1, 2]), 48000, 1, { startFrame: 1, endFrame: 1 })).toThrow(
      RangeError,
    );
  });

  it('trims to the shortest result so the channels stay planar', () => {
    let call = 0;
    const noteMove = noteMoveFn(({ samples }) => (call++ === 0 ? samples : samples.slice(0, 2)));
    expect(plain(noteMoveRange({ noteMove }, ch([1, 2, 3], [4, 5, 6]), 48000, 1))).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });
});

describe('splitSilenceFrames', () => {
  it('downmixes to mono and returns the interior cut frames', () => {
    const splitSilence = vi.fn((request: SplitSilenceRequest) => {
      const { samples, sampleRate, ...options } = request;
      // The detector should receive the channel average over 8 frames.
      expect([...samples]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
      expect(sampleRate).toBe(48000);
      expect(options).toEqual({ topDb: 30 });
      return new Int32Array([0, 2, 5, 8]); // intervals -> interior cuts 2, 5.
    });
    const left = new Float32Array([2, 0, 0, 0, 0, 0, 0, 0]);
    const right = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(
      splitSilenceFrames({ splitSilence: splitSilenceFn(splitSilence) }, [left, right], 48000, 30),
    ).toEqual([2, 5]);
    expect(splitSilence).toHaveBeenCalledTimes(1);
  });

  it('omits topDb when not given', () => {
    const splitSilence = vi.fn((_request: SplitSilenceRequest) => new Int32Array([0, 4]));
    splitSilenceFrames(
      { splitSilence: splitSilenceFn(splitSilence) },
      [new Float32Array(4)],
      48000,
    );
    expect(splitSilence).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 48000,
    });
  });

  it('throws when splitSilence is unavailable or topDb is not positive', () => {
    expect(() => splitSilenceFrames({}, [new Float32Array([1])], 48000)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { splitSilence: () => new Int32Array() };
    expect(() => splitSilenceFrames(mod, [new Float32Array([1])], 48000, 0)).toThrow(RangeError);
    expect(() => splitSilenceFrames(mod, [new Float32Array([1])], 48000, Number.NaN)).toThrow(
      RangeError,
    );
  });
});

describe('loadSampleEditorWasm', () => {
  it('returns the initialized module', async () => {
    const mod = { pitchShift: vi.fn() };
    ensureWasmMock.mockResolvedValue(mod);
    await expect(loadSampleEditorWasm()).resolves.toBe(mod);
  });

  it('returns null when the module fails to initialize', async () => {
    ensureWasmMock.mockRejectedValue(new Error('no wasm here'));
    await expect(loadSampleEditorWasm()).resolves.toBeNull();
  });
});

describe('pitchShiftRange', () => {
  it('delegates per channel over the range and splices the result back', () => {
    const pitchShift = vi.fn((request: PitchShiftRequest) =>
      request.samples.map((v) => v + request.pitchSemitones),
    );
    const mod: SampleEditorWasmOps = { pitchShift: pitchShiftFn(pitchShift) };
    const input = ch([1, 2, 3, 4], [5, 6, 7, 8]);
    const out = pitchShiftRange(mod, input, 48000, 10, { startFrame: 1, endFrame: 3 });
    expect(plain(out)).toEqual([
      [1, 12, 13, 4],
      [5, 16, 17, 8],
    ]);
    expect(plain(input)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(pitchShift).toHaveBeenCalledTimes(2);
    expect(pitchShift.mock.calls[0][0].sampleRate).toBe(48000);
  });

  it('defaults to the whole file without a range', () => {
    const mod: SampleEditorWasmOps = {
      pitchShift: pitchShiftFn((request) => request.samples.map((v) => -v)),
    };
    expect(plain(pitchShiftRange(mod, ch([1, 2]), 48000, 12))).toEqual([[-1, -2]]);
  });

  it('throws when pitchShift is unavailable or input is invalid', () => {
    expect(() => pitchShiftRange({}, ch([1]), 48000, 1)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { pitchShift: pitchShiftFn((request) => request.samples) };
    expect(() => pitchShiftRange(mod, ch([1]), 48000, Number.NaN)).toThrow(RangeError);
    expect(() =>
      pitchShiftRange(mod, ch([1, 2]), 48000, 1, { startFrame: 1, endFrame: 1 }),
    ).toThrow(/empty range/);
  });
});

describe('estimateSourceMidi', () => {
  it('maps the tracker median F0 to a MIDI number', () => {
    const pitchYin = vi.fn((_request: PitchYinRequest) => pitchResult({ medianF0: 440 }));
    expect(
      estimateSourceMidi({ pitchYin: pitchYinFn(pitchYin) }, new Float32Array([1, 2]), 48000),
    ).toBeCloseTo(69);
    expect(pitchYin).toHaveBeenCalledWith({ samples: new Float32Array([1, 2]), sampleRate: 48000 });
  });

  it('throws when the tracker is missing or finds no pitch', () => {
    expect(() => estimateSourceMidi({}, new Float32Array(2), 48000)).toThrow(/unavailable/);
    expect(() =>
      estimateSourceMidi({ pitchYin: () => pitchResult() }, new Float32Array(2), 48000),
    ).toThrow(/detect a pitch/);
  });
});

describe('pitchCorrectRange', () => {
  it('estimates the source pitch on the mono downmix and retunes every channel by it', () => {
    const pitchYin = vi.fn((request: PitchYinRequest) => {
      // The detector sees the channel average over the range: ([2,3]+[6,7])/2.
      expect([...request.samples]).toEqual([4, 5]);
      return pitchResult({ medianF0: 440 });
    });
    const pitchCorrectToMidi = vi.fn((request: PitchCorrectToMidiRequest) => {
      expect(request.currentMidi).toBeCloseTo(69);
      return request.samples.map((v) => v + request.targetMidi);
    });
    const mod: SampleEditorWasmOps = {
      pitchYin: pitchYinFn(pitchYin),
      pitchCorrectToMidi: pitchCorrectToMidiFn(pitchCorrectToMidi),
    };
    const out = pitchCorrectRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 67, {
      startFrame: 1,
      endFrame: 3,
    });
    expect(plain(out)).toEqual([
      [1, 69, 70, 4],
      [5, 73, 74, 8],
    ]);
    expect(pitchYin).toHaveBeenCalledTimes(1);
    expect(pitchCorrectToMidi).toHaveBeenCalledTimes(2);
    expect(pitchCorrectToMidi.mock.calls[0][0].sampleRate).toBe(48000);
  });

  it('defaults to the whole file without a range', () => {
    const mod: SampleEditorWasmOps = {
      pitchYin: () => pitchResult({ medianF0: 440 }),
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples.map((v) => -v)),
    };
    expect(plain(pitchCorrectRange(mod, ch([1, 2]), 48000, 60))).toEqual([[-1, -2]]);
  });

  it('throws when unavailable, no pitch is found or the target note is out of range', () => {
    expect(() => pitchCorrectRange({}, ch([1]), 48000, 60)).toThrow(/unavailable/);
    expect(() =>
      pitchCorrectRange(
        { pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples) },
        ch([1]),
        48000,
        60,
      ),
    ).toThrow(/unavailable/);
    const unvoiced: SampleEditorWasmOps = {
      pitchYin: () => pitchResult(),
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples),
    };
    expect(() => pitchCorrectRange(unvoiced, ch([1, 2]), 48000, 60)).toThrow(/detect a pitch/);
    const mod: SampleEditorWasmOps = {
      pitchYin: () => pitchResult({ medianF0: 440 }),
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples),
    };
    expect(() => pitchCorrectRange(mod, ch([1]), 48000, 60.5)).toThrow(RangeError);
    expect(() => pitchCorrectRange(mod, ch([1]), 48000, -1)).toThrow(RangeError);
    expect(() => pitchCorrectRange(mod, ch([1]), 48000, 128)).toThrow(RangeError);
  });
});

describe('pitchCorrectTimevaryingRange', () => {
  it('detects one mono F0 contour and applies it to every channel', () => {
    const pitchPyin = vi.fn((request: PitchPyinRequest) => {
      expect([...request.samples]).toEqual([4, 5]);
      expect(request.sampleRate).toBe(48000);
      expect(request).toMatchObject({ frameLength: 2048, hopLength: 512 });
      return pitchResult({
        f0: new Float32Array([220, 224]),
        voicedProb: new Float32Array([0.9, 0.8]),
        voicedFlag: [true, false],
        medianF0: 222,
      });
    });
    const pitchCorrectTimevarying = vi.fn((request: PitchCorrectTimevaryingRequest) => {
      expect([...request.f0Hz]).toEqual([220, 224]);
      expect(request.targetMode).toBe('midi');
      expect(request.targetMidi).toBe(69);
      expect(request.sampleRate).toBe(48000);
      expect(request.hopLength).toBe(512);
      expect(request.voiced ? [...request.voiced] : []).toEqual([1, 0]);
      // The tracker's confidence must not reach the corrector: it reads the
      // field as the per-frame correction weight, so forwarding it silently
      // applies a fraction of the requested correction.
      expect(request).not.toHaveProperty('voicedProb');
      return request.samples.map((value) => value + 10);
    });

    const out = pitchCorrectTimevaryingRange(
      {
        pitchPyin: pitchPyinFn(pitchPyin),
        pitchCorrectTimevarying: pitchCorrectTimevaryingFn(pitchCorrectTimevarying),
      },
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      48000,
      69,
      { startFrame: 1, endFrame: 3 },
    );

    expect(plain(out)).toEqual([
      [1, 12, 13, 4],
      [5, 16, 17, 8],
    ]);
    expect(pitchPyin).toHaveBeenCalledTimes(1);
    expect(pitchCorrectTimevarying).toHaveBeenCalledTimes(2);
  });

  it('falls back to pitchYin and validates inputs', () => {
    const pitchYin = vi.fn(() =>
      pitchResult({
        f0: new Float32Array([330]),
        voicedProb: new Float32Array([1]),
        voicedFlag: [true],
        medianF0: 330,
      }),
    );
    const pitchCorrectTimevarying = pitchCorrectTimevaryingFn((request) => request.samples);
    const mod: SampleEditorWasmOps = { pitchYin, pitchCorrectTimevarying };

    expect(plain(pitchCorrectTimevaryingRange(mod, ch([1]), 48000, 60))).toEqual([[1]]);
    expect(() => pitchCorrectTimevaryingRange({}, ch([1]), 48000, 60)).toThrow(/unavailable/);
    expect(() => pitchCorrectTimevaryingRange(mod, ch([1]), 48000, 128)).toThrow(RangeError);
    expect(() =>
      pitchCorrectTimevaryingRange(mod, ch([1, 2]), 48000, 60, { startFrame: 1, endFrame: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      pitchCorrectTimevaryingRange(
        {
          pitchYin: () => pitchResult({ f0: new Float32Array([0]) }),
          pitchCorrectTimevarying,
        },
        ch([1]),
        48000,
        60,
      ),
    ).toThrow(/pitch contour/);
  });
});

describe('scaleCorrectRange', () => {
  it('detects pitch on the mono downmix and retunes every channel to the scale target', () => {
    const pitchYin = vi.fn((request: PitchYinRequest) => {
      // The detector sees the channel average over the range: ([2,3]+[6,7])/2.
      expect([...request.samples]).toEqual([4, 5]);
      return pitchResult({ medianF0: 440 });
    });
    const scaleQuantizeMidi = vi.fn((root: number, mask: number, midi: number) => {
      expect(root).toBe(0);
      expect(mask).toBe(0b101010110101);
      expect(midi).toBeCloseTo(69); // hzToMidi(440)
      return 67; // snap A4 -> G4
    });
    const pitchCorrectToMidi = vi.fn((request: PitchCorrectToMidiRequest) => {
      expect(request.currentMidi).toBeCloseTo(69);
      expect(request.targetMidi).toBe(67);
      return request.samples.map((v) => v + request.targetMidi);
    });
    const mod: SampleEditorWasmOps = {
      pitchYin: pitchYinFn(pitchYin),
      scaleQuantizeMidi,
      pitchCorrectToMidi: pitchCorrectToMidiFn(pitchCorrectToMidi),
    };
    const out = scaleCorrectRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 0, 0b101010110101, {
      startFrame: 1,
      endFrame: 3,
    });
    expect(plain(out)).toEqual([
      [1, 69, 70, 4],
      [5, 73, 74, 8],
    ]);
    expect(pitchYin).toHaveBeenCalledTimes(1);
    expect(pitchCorrectToMidi).toHaveBeenCalledTimes(2);
  });

  it('throws when a required function is missing or no pitch is detected', () => {
    const base = {
      scaleQuantizeMidi: (_r: number, _m: number, midi: number) => midi,
      pitchCorrectToMidi: pitchCorrectToMidiFn((request) => request.samples),
    };
    expect(() => scaleCorrectRange(base, ch([1]), 48000, 0, 1)).toThrow(/unavailable/);
    const unvoiced: SampleEditorWasmOps = { ...base, pitchYin: () => pitchResult() };
    expect(() => scaleCorrectRange(unvoiced, ch([1, 2]), 48000, 0, 1)).toThrow(/detect a pitch/);
  });
});

describe('tuneToReferenceRange', () => {
  it('estimates tuning on the mono downmix and shifts every channel by its opposite', () => {
    const estimateTuning = vi.fn((request: EstimateTuningRequest) => {
      // The estimator sees the channel average over the range: ([2,3]+[6,7])/2.
      expect([...request.samples]).toEqual([4, 5]);
      return 0.25; // a quarter-semitone sharp
    });
    const pitchShift = vi.fn((request: PitchShiftRequest) => {
      expect(request.pitchSemitones).toBeCloseTo(-0.25); // correct downward to A440
      return request.samples.map((v) => v * 10);
    });
    const mod: SampleEditorWasmOps = {
      estimateTuning: estimateTuningFn(estimateTuning),
      pitchShift: pitchShiftFn(pitchShift),
    };
    const out = tuneToReferenceRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, {
      startFrame: 1,
      endFrame: 3,
    });
    expect(plain(out)).toEqual([
      [1, 20, 30, 4],
      [5, 60, 70, 8],
    ]);
    expect(estimateTuning).toHaveBeenCalledTimes(1);
    expect(pitchShift).toHaveBeenCalledTimes(2);
  });

  it('throws when a required function is missing or the tuning is not finite', () => {
    expect(() =>
      tuneToReferenceRange({ pitchShift: pitchShiftFn((r) => r.samples) }, ch([1]), 48000),
    ).toThrow(/unavailable/);
    expect(() => tuneToReferenceRange({ estimateTuning: () => 0 }, ch([1]), 48000)).toThrow(
      /unavailable/,
    );
    const broken: SampleEditorWasmOps = {
      estimateTuning: () => Number.NaN,
      pitchShift: pitchShiftFn((request) => request.samples),
    };
    expect(() => tuneToReferenceRange(broken, ch([1, 2]), 48000)).toThrow(/tuning offset/);
  });
});

describe('voiceChangeRange', () => {
  it('passes pitch and formant options through per channel over the range', () => {
    const voiceChange = vi.fn((request: VoiceChangeRequest) => {
      const { samples, sampleRate: _sampleRate, ...options } = request;
      expect(options).toEqual({
        pitchSemitones: 3,
        formantFactor: 1.2,
        formantMode: 'absolute',
      });
      return samples.map((v) => v + (options.pitchSemitones ?? 0));
    });
    const mod: SampleEditorWasmOps = { voiceChange: voiceChangeFn(voiceChange) };
    const out = voiceChangeRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 3, 1.2, 'absolute', {
      startFrame: 1,
      endFrame: 3,
    });
    expect(plain(out)).toEqual([
      [1, 5, 6, 4],
      [5, 9, 10, 8],
    ]);
    expect(voiceChange).toHaveBeenCalledTimes(2);
    expect(voiceChange.mock.calls[0][0].sampleRate).toBe(48000);
  });

  it('defaults to the whole file without a range', () => {
    const mod: SampleEditorWasmOps = {
      voiceChange: voiceChangeFn((request) => request.samples.map((v) => -v)),
    };
    expect(plain(voiceChangeRange(mod, ch([1, 2]), 48000, 0, 1, 'relative'))).toEqual([[-1, -2]]);
  });

  it('throws when unavailable or the parameters are invalid', () => {
    expect(() => voiceChangeRange({}, ch([1]), 48000, 0, 1, 'relative')).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { voiceChange: voiceChangeFn((request) => request.samples) };
    expect(() => voiceChangeRange(mod, ch([1]), 48000, Number.NaN, 1, 'relative')).toThrow(
      RangeError,
    );
    expect(() => voiceChangeRange(mod, ch([1]), 48000, 0, 0, 'relative')).toThrow(RangeError);
    expect(() => voiceChangeRange(mod, ch([1]), 48000, 0, -1, 'relative')).toThrow(RangeError);
  });

  it("propagates libsonare's refusal of an unreachable absolute request", () => {
    const refusal = new RangeError('formantFactor must be in [0.69, 2.08] for +4 semitones');
    const mod: SampleEditorWasmOps = {
      voiceChange: () => {
        throw refusal;
      },
    };
    expect(() => voiceChangeRange(mod, ch([1]), 48000, 4, 3, 'absolute')).toThrow(refusal);
  });
});

describe('autoTuneRange', () => {
  it('resolves the key on the first channel and shares it with the rest', () => {
    const autoTune = vi.fn((request: AutoTuneRequest) =>
      autoTuneResult(
        request.samples.map((v) => v * 10),
        { root: 9, mode: 'minor', confidence: 0.6 },
      ),
    );
    const mod: SampleEditorWasmOps = { autoTune: autoTuneFn(autoTune) };
    const out = autoTuneRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 44100, 'detect', 0.8, {
      startFrame: 1,
      endFrame: 3,
    });
    expect(plain(out.channels)).toEqual([
      [1, 20, 30, 4],
      [5, 60, 70, 8],
    ]);
    expect(out.key).toMatchObject({ root: 9, mode: 'minor', confidence: 0.6 });
    expect(autoTune).toHaveBeenCalledTimes(2);
    expect(autoTune.mock.calls[0][0]).toMatchObject({
      sampleRate: 44100,
      key: 'detect',
      retuneAmount: 0.8,
    });
    expect(autoTune.mock.calls[1][0]).toMatchObject({
      key: { root: 9, mode: 'minor' },
      retuneAmount: 0.8,
    });
  });

  it('passes a named key through', () => {
    const autoTune = vi.fn((request: AutoTuneRequest) =>
      autoTuneResult(request.samples, { root: 2, mode: 'dorian', confidence: 1 }),
    );
    const mod: SampleEditorWasmOps = { autoTune: autoTuneFn(autoTune) };
    autoTuneRange(mod, ch([1, 2]), 48000, { root: 2, mode: 'dorian' }, 1);
    expect(autoTune.mock.calls[0][0]).toMatchObject({ key: { root: 2, mode: 'dorian' } });
  });

  it('throws when unavailable or the range is empty', () => {
    expect(() => autoTuneRange({}, ch([1]), 48000, 'detect', 1)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = {
      autoTune: autoTuneFn((request) => autoTuneResult(request.samples)),
    };
    expect(() =>
      autoTuneRange(mod, ch([1, 2]), 48000, 'detect', 1, { startFrame: 1, endFrame: 1 }),
    ).toThrow(RangeError);
  });
});

describe('analyzeRepairRange / repairStagesRange', () => {
  it('analyzes every channel of the range in one call', () => {
    const analysis = repairAnalysis({ recommended: [{ stage: 'declick' }] });
    const masteringRepairAnalyze = vi.fn((_request: MasteringRepairAnalyzeRequest) => analysis);
    const mod: SampleEditorWasmOps = { masteringRepairAnalyze };
    expect(
      analyzeRepairRange(mod, ch([1, 2, 3], [4, 5, 6]), 48000, { startFrame: 1, endFrame: 3 }),
    ).toBe(analysis);
    expect(masteringRepairAnalyze).toHaveBeenCalledWith({
      channels: [new Float32Array([2, 3]), new Float32Array([5, 6])],
      sampleRate: 48000,
    });
  });

  it('applies the stages to the range in one call and splices the result', () => {
    const masteringRepairApply = vi.fn((request: MasteringRepairApplyRequest) =>
      repairApplyResult(request.channels.map((c) => c.map((v) => -v))),
    );
    const mod: SampleEditorWasmOps = { masteringRepairApply };
    const stages = [{ stage: 'dehum' as const, fundamentalHz: 50 }, { stage: 'declick' as const }];
    const out = repairStagesRange(mod, ch([1, 2, 3], [4, 5, 6]), 48000, stages, {
      startFrame: 0,
      endFrame: 2,
    });
    expect(plain(out)).toEqual([
      [-1, -2, 3],
      [-4, -5, 6],
    ]);
    expect(masteringRepairApply).toHaveBeenCalledTimes(1);
    expect(masteringRepairApply.mock.calls[0][0]).toMatchObject({ sampleRate: 48000, stages });
  });

  it('throws when unavailable, with no stage, or on an empty range', () => {
    expect(() => analyzeRepairRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => repairStagesRange({}, ch([1]), 48000, [{ stage: 'declick' }])).toThrow(
      /unavailable/,
    );
    const mod: SampleEditorWasmOps = {
      masteringRepairAnalyze: () => repairAnalysis(),
      masteringRepairApply: (request) => repairApplyResult(request.channels),
    };
    expect(() => repairStagesRange(mod, ch([1]), 48000, [])).toThrow(RangeError);
    expect(() =>
      analyzeRepairRange(mod, ch([1, 2]), 48000, { startFrame: 1, endFrame: 1 }),
    ).toThrow(RangeError);
  });
});

describe('timeStretchRange', () => {
  it('splices a length-changing segment back (total length changes)', () => {
    // Rate 2 halves the duration: keep every other sample.
    const timeStretch = vi.fn((request: TimeStretchRequest) =>
      request.samples.filter((_, i) => i % 2 === 0),
    );
    const mod: SampleEditorWasmOps = { timeStretch: timeStretchFn(timeStretch) };
    const out = timeStretchRange(mod, ch([1, 2, 3, 4, 9]), 48000, 2, {
      startFrame: 0,
      endFrame: 4,
    });
    expect(plain(out)).toEqual([[1, 3, 9]]);
  });

  it('trims channels to the shortest segment so output stays planar', () => {
    let call = 0;
    const mod: SampleEditorWasmOps = {
      timeStretch: timeStretchFn(({ samples }) => {
        call += 1;
        // Second channel comes back one frame longer than the first.
        return call === 1 ? samples.slice(0, 2) : samples.slice(0, 3);
      }),
    };
    const out = timeStretchRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 1.5);
    expect(out[0].length).toBe(2);
    expect(out[1].length).toBe(2);
    expect(plain(out)).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('throws when timeStretch is unavailable or the rate is invalid', () => {
    expect(() => timeStretchRange({}, ch([1]), 48000, 2)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { timeStretch: timeStretchFn((request) => request.samples) };
    expect(() => timeStretchRange(mod, ch([1]), 48000, 0)).toThrow(RangeError);
    expect(() => timeStretchRange(mod, ch([1]), 48000, -1)).toThrow(RangeError);
  });
});

describe('noteStretchRange', () => {
  it('passes the whole buffer with the range as the region bounds', () => {
    const noteStretch = vi.fn((request: NoteStretchRequest) => request.samples);
    const mod: SampleEditorWasmOps = { noteStretch: noteStretchFn(noteStretch) };
    const out = noteStretchRange(mod, ch([1, 2, 3, 4, 5]), 48000, 2, {
      startFrame: 1,
      endFrame: 4,
    });
    // The detector sees the entire buffer, not just the selected region.
    const { samples, sampleRate, ...options } = noteStretch.mock.calls[0][0];
    expect([...samples]).toEqual([1, 2, 3, 4, 5]);
    expect(sampleRate).toBe(48000);
    // Rate 2 halves the note, which noteStretch spells as a duration factor.
    expect(options).toEqual({
      onsetSample: 1,
      offsetSample: 4,
      stretchRatio: 0.5,
    });
    expect(plain(out)).toEqual([[1, 2, 3, 4, 5]]);
  });

  it('trims channels to the shortest result so output stays planar', () => {
    let call = 0;
    const mod: SampleEditorWasmOps = {
      noteStretch: noteStretchFn(({ samples }) => {
        call += 1;
        return call === 1 ? samples.slice(0, 3) : samples.slice(0, 4);
      }),
    };
    const out = noteStretchRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 1.5);
    expect(plain(out)).toEqual([
      [1, 2, 3],
      [5, 6, 7],
    ]);
  });

  it('throws when noteStretch is unavailable, the rate is invalid, or the range is empty', () => {
    expect(() => noteStretchRange({}, ch([1]), 48000, 2)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { noteStretch: noteStretchFn((request) => request.samples) };
    expect(() => noteStretchRange(mod, ch([1]), 48000, 0)).toThrow(RangeError);
    expect(() => noteStretchRange(mod, ch([1]), 48000, -1)).toThrow(RangeError);
    expect(() =>
      noteStretchRange(mod, ch([1, 2, 3]), 48000, 2, { startFrame: 2, endFrame: 2 }),
    ).toThrow(RangeError);
  });
});

describe('HPSS separation', () => {
  it('harmonicRange delegates per channel over the range', () => {
    const harmonic = vi.fn((request: HarmonicRequest) => request.samples.map((v) => v * 0.5));
    const out = harmonicRange(
      { harmonic: harmonicFn(harmonic) },
      ch([2, 4, 6], [8, 10, 12]),
      44100,
      {
        startFrame: 1,
        endFrame: 3,
      },
    );
    expect(plain(out)).toEqual([
      [2, 2, 3],
      [8, 5, 6],
    ]);
    expect(harmonic).toHaveBeenCalledWith({ samples: expect.any(Float32Array), sampleRate: 44100 });
    expect(harmonic).toHaveBeenCalledTimes(2);
  });

  it('percussiveRange delegates per channel over the whole file by default', () => {
    const percussive = percussiveFn((request) => request.samples.map((v) => -v));
    expect(plain(percussiveRange({ percussive }, ch([1, 2]), 48000))).toEqual([[-1, -2]]);
  });

  it('both throw when the separator is unavailable', () => {
    expect(() => harmonicRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => percussiveRange({}, ch([1]), 48000)).toThrow(/unavailable/);
  });
});

describe('spectralDenoiseRange', () => {
  it('delegates a selection-scoped high-frequency attenuation op per channel', () => {
    const spectralEdit = vi.fn((request: SpectralEditRequest) =>
      request.samples.map((value) => value * 0.25),
    );

    const out = spectralDenoiseRange(
      { spectralEdit: spectralEditFn(spectralEdit) },
      ch([1, 2, 3], [4, 5, 6]),
      48000,
      {
        startFrame: 1,
        endFrame: 3,
      },
    );

    expect(plain(out)).toEqual([
      [0.25, 0.5, 0.75],
      [1, 1.25, 1.5],
    ]);
    expect(spectralEdit).toHaveBeenCalledTimes(2);
    expect(spectralEdit).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 48000,
      ops: [
        {
          startSample: 1,
          endSample: 3,
          lowHz: 4000,
          gainDb: -18,
          mode: 'attenuate',
        },
      ],
      nFft: 2048,
      hopLength: 512,
      window: 'hann',
    });
  });

  it('validates availability and numeric parameters', () => {
    const mod: SampleEditorWasmOps = { spectralEdit: spectralEditFn((request) => request.samples) };

    expect(() => spectralDenoiseRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => spectralDenoiseRange(mod, ch([1]), 0)).toThrow(RangeError);
    expect(() => spectralDenoiseRange(mod, ch([1]), 48000, null, -1)).toThrow(RangeError);
    expect(() => spectralDenoiseRange(mod, ch([1]), 48000, null, 4000, Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      spectralDenoiseRange(mod, ch([1, 2]), 48000, { startFrame: 1, endFrame: 1 }),
    ).toThrow(RangeError);
  });
});

describe('spectralEditRange', () => {
  it('delegates a custom rectangular spectral op per channel', () => {
    const spectralEdit = vi.fn((request: SpectralEditRequest) =>
      request.samples.map((value) => value + 1),
    );

    const out = spectralEditRange(
      { spectralEdit: spectralEditFn(spectralEdit) },
      ch([1, 2, 3], [4, 5, 6]),
      44100,
      { startFrame: 0, endFrame: 2 },
      { lowHz: 250, highHz: 1800, gainDb: -9, mode: 'heal' },
    );

    expect(plain(out)).toEqual([
      [2, 3, 4],
      [5, 6, 7],
    ]);
    expect(spectralEdit).toHaveBeenCalledTimes(2);
    expect(spectralEdit).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 44100,
      ops: [
        {
          startSample: 0,
          endSample: 2,
          lowHz: 250,
          highHz: 1800,
          gainDb: -9,
          mode: 'heal',
        },
      ],
      nFft: 2048,
      hopLength: 512,
      window: 'hann',
    });
  });

  it('validates custom spectral edit bounds', () => {
    const mod: SampleEditorWasmOps = { spectralEdit: spectralEditFn((request) => request.samples) };
    const options = { lowHz: 4000, highHz: 3000, gainDb: -6, mode: 'attenuate' as const };

    expect(() => spectralEditRange({}, ch([1]), 48000, null, options)).toThrow(/unavailable/);
    expect(() => spectralEditRange(mod, ch([1]), 48000, null, options)).toThrow(RangeError);
    expect(() =>
      spectralEditRange(mod, ch([1]), 48000, null, {
        lowHz: 4000,
        highHz: 0,
        gainDb: Number.NaN,
        mode: 'gain',
      }),
    ).toThrow(RangeError);
  });
});

describe('repair operations', () => {
  it('declickRange delegates with the sample rate over the range', () => {
    const masteringRepairDeclick = vi.fn((request: MasteringRepairDeclickRequest) =>
      declickResult(request.samples.map(() => 0.5)),
    );
    const out = declickRange(
      { masteringRepairDeclick: declickFn(masteringRepairDeclick) },
      ch([1, 2, 3]),
      44100,
      { startFrame: 1, endFrame: 2 },
    );
    expect(plain(out)).toEqual([[1, 0.5, 3]]);
    expect(masteringRepairDeclick).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 44100,
    });
  });

  it('denoiseRange delegates per channel', () => {
    const masteringRepairDenoiseClassical = denoiseClassicalFn((request) =>
      denoiseResult(request.samples.map((v) => v * 0.5)),
    );
    const out = denoiseRange({ masteringRepairDenoiseClassical }, ch([2, 2], [4, 4]), 48000);
    expect(plain(out)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('additional repair processors delegate per channel and support shortened output', () => {
    const masteringRepairDeclip = vi.fn((request: MasteringRepairDeclipRequest) =>
      declipResult(request.samples.map((v) => Math.max(-0.8, Math.min(0.8, v)))),
    );
    const masteringRepairDecrackle = decrackleFn((request) =>
      decrackleResult(request.samples.map((v) => v * 0.75)),
    );
    const masteringRepairDehum = dehumFn((request) =>
      dehumResult(request.samples.map((v) => v - 0.1)),
    );
    const masteringRepairDereverbClassical = dereverbClassicalFn((request) =>
      dereverbResult(request.samples.map((v) => v * 0.25)),
    );
    const masteringRepairTrimSilence = vi.fn((request: MasteringRepairTrimSilenceRequest) =>
      trimSilenceResult(request.samples.slice(1, 3)),
    );

    expect(
      plain(
        declipRange({ masteringRepairDeclip: declipFn(masteringRepairDeclip) }, ch([1, -1]), 44100),
      ),
    ).toEqual([[0.800000011920929, -0.800000011920929]]);
    expect(plain(decrackleRange({ masteringRepairDecrackle }, ch([4, 8]), 44100))).toEqual([
      [3, 6],
    ]);
    expect(plain(dehumRange({ masteringRepairDehum }, ch([0.2, 0.3]), 44100))).toEqual([
      [0.10000000149011612, 0.20000001788139343],
    ]);
    expect(plain(dereverbRange({ masteringRepairDereverbClassical }, ch([4, 8]), 44100))).toEqual([
      [1, 2],
    ]);
    expect(
      plain(
        trimSilenceRange(
          { masteringRepairTrimSilence: trimSilenceFn(masteringRepairTrimSilence) },
          ch([9, 1, 2, 9], [8, 3, 4, 8]),
          44100,
          { startFrame: 1, endFrame: 4 },
        ),
      ),
    ).toEqual([
      [9, 2, 9],
      [8, 4, 8],
    ]);
    expect(masteringRepairDeclip).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 44100,
    });
    expect(masteringRepairTrimSilence).toHaveBeenCalledTimes(2);
  });

  it('all throw when the processor is unavailable', () => {
    expect(() => declickRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => denoiseRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => declipRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => decrackleRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => dehumRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => dereverbRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => trimSilenceRange({}, ch([1]), 48000)).toThrow(/unavailable/);
  });
});

describe('roomMorphChannels', () => {
  const preset = { lengthM: 4, widthM: 3, heightM: 2.6, materialPreset: 'wood' as const };
  const morphed = roomMorphResult;

  it('processes whole channels, forwards the room options, and tail-extends', () => {
    const roomMorph = vi.fn((request: RoomMorphRequest) => {
      const { samples, sampleRate: _sampleRate, ...options } = request;
      expect(options).toEqual({
        lengthM: 4,
        widthM: 3,
        heightM: 2.6,
        materialPreset: 'wood',
        wet: 0.5,
      });
      // Echo the input then append a two-sample "tail" so the result is longer.
      return morphed(new Float32Array([...samples, 0, 0]));
    });
    const out = roomMorphChannels(
      { roomMorph: roomMorphFn(roomMorph) },
      ch([1, 2], [3, 4]),
      48000,
      preset,
      0.5,
    );
    expect(plain(out.channels)).toEqual([
      [1, 2, 0, 0],
      [3, 4, 0, 0],
    ]);
    expect(out.diagnostics).toEqual([]);
    expect(roomMorph).toHaveBeenCalledTimes(2);
    expect(roomMorph.mock.calls[0][0].sampleRate).toBe(48000);
  });

  it('reports the room synthesis diagnostics once for all channels', () => {
    const diagnostic: RirDiagnostic = {
      code: 'acoustic.rir_tail_truncated',
      message: 'tail truncated',
      severity: 'warning',
    };
    const roomMorph = roomMorphFn((request) => morphed(request.samples, [diagnostic]));
    const out = roomMorphChannels({ roomMorph }, ch([1], [2]), 48000, preset, 0.5);
    expect(out.diagnostics).toEqual([diagnostic]);
  });

  it('asks for air absorption only when it is switched on', () => {
    const seen: RoomMorphRequest[] = [];
    const roomMorph = roomMorphFn((request) => {
      seen.push(request);
      return morphed(request.samples);
    });
    roomMorphChannels({ roomMorph }, ch([1]), 48000, preset, 0.5);
    roomMorphChannels({ roomMorph }, ch([1]), 48000, preset, 0.5, true);
    expect(seen[0]).not.toHaveProperty('airAbsorptionEnabled');
    expect(seen[1]).toMatchObject({ airAbsorptionEnabled: true });
  });

  it('trims channels to the shortest result to stay planar', () => {
    let call = 0;
    const roomMorph = roomMorphFn(({ samples }) => {
      call += 1;
      // Second channel comes back one sample shorter.
      return morphed(
        call === 1 ? new Float32Array([...samples, 0, 0]) : new Float32Array([...samples, 0]),
      );
    });
    const out = roomMorphChannels({ roomMorph }, ch([1, 2], [3, 4]), 48000, preset, 0.3);
    expect(out.channels.every((channel) => channel.length === 3)).toBe(true);
  });

  it('clamps the wet mix to [0, 1] and falls back to 0.35 for non-finite values', () => {
    const seen: number[] = [];
    const roomMorph = roomMorphFn((request) => {
      seen.push(request.wet ?? Number.NaN);
      return morphed(request.samples);
    });
    roomMorphChannels({ roomMorph }, ch([1]), 48000, preset, 2);
    roomMorphChannels({ roomMorph }, ch([1]), 48000, preset, -1);
    roomMorphChannels({ roomMorph }, ch([1]), 48000, preset, Number.NaN);
    expect(seen).toEqual([1, 0, 0.35]);
  });

  it('renders a stereo pair through roomMorphStereo and keeps the channels planar', () => {
    const diagnostic: RirDiagnostic = {
      code: 'acoustic.rir_tail_truncated',
      message: 'tail truncated',
      severity: 'warning',
    };
    const roomMorph = vi.fn((request: RoomMorphRequest) => morphed(request.samples));
    const roomMorphStereo = vi.fn((request: RoomMorphStereoRequest) =>
      roomMorphStereoResult(
        new Float32Array([...request.left, 0, 0]),
        new Float32Array([...request.right, 0]),
        [diagnostic],
      ),
    );
    const out = roomMorphChannels(
      { roomMorph: roomMorphFn(roomMorph), roomMorphStereo },
      ch([1, 2], [3, 4]),
      48000,
      preset,
      0.5,
      true,
    );
    expect(roomMorph).not.toHaveBeenCalled();
    expect(roomMorphStereo).toHaveBeenCalledOnce();
    expect(roomMorphStereo.mock.calls[0][0]).toMatchObject({
      sampleRate: 48000,
      lengthM: 4,
      widthM: 3,
      heightM: 2.6,
      materialPreset: 'wood',
      wet: 0.5,
      airAbsorptionEnabled: true,
    });
    expect(plain(out.channels)).toEqual([
      [1, 2, 0],
      [3, 4, 0],
    ]);
    expect(out.diagnostics).toEqual([diagnostic]);
  });

  it('keeps mono roomMorph for one channel and per-channel roomMorph beyond two', () => {
    const roomMorph = vi.fn((request: RoomMorphRequest) => morphed(request.samples));
    const roomMorphStereo = vi.fn((request: RoomMorphStereoRequest) =>
      roomMorphStereoResult(request.left, request.right),
    );
    const ops: SampleEditorWasmOps = { roomMorph: roomMorphFn(roomMorph), roomMorphStereo };
    roomMorphChannels(ops, ch([1]), 48000, preset, 0.5);
    roomMorphChannels(ops, ch([1], [2], [3]), 48000, preset, 0.5);
    expect(roomMorph).toHaveBeenCalledTimes(4);
    expect(roomMorphStereo).not.toHaveBeenCalled();
  });

  it('throws when unavailable, the sample rate is invalid, or there are no channels', () => {
    expect(() => roomMorphChannels({}, ch([1]), 48000, preset, 0.5)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = {
      roomMorph: roomMorphFn((request) => morphed(request.samples)),
    };
    expect(() => roomMorphChannels(mod, ch([1]), 0, preset, 0.5)).toThrow(RangeError);
    expect(() => roomMorphChannels(mod, [], 48000, preset, 0.5)).toThrow(RangeError);
  });
});

describe('synthesizeRirChannels', () => {
  const preset = { lengthM: 6, widthM: 4, heightM: 3, materialPreset: 'wood' as const };

  it('synthesizes a mono RIR from the selected room preset', () => {
    const diagnostic: RirDiagnostic = {
      code: 'acoustic.ism_order_clamped',
      message: 'order clamped',
      severity: 'warning',
    };
    const synthesizeRir = vi.fn((options: SynthesizeRirRequest) => {
      expect(options).toEqual({
        sampleRate: 48000,
        lengthM: 6,
        widthM: 4,
        heightM: 3,
        materialPreset: 'wood',
      });
      return rirResult(new Float32Array([1, 0.5, 0.25]), [diagnostic]);
    });

    const out = synthesizeRirChannels({ synthesizeRir }, 48000, preset);
    expect(plain(out.channels)).toEqual([[1, 0.5, 0.25]]);
    expect(out.diagnostics).toEqual([diagnostic]);
  });

  it('validates availability, sample rate and synth errors', () => {
    expect(() => synthesizeRirChannels({}, 48000, preset)).toThrow(/unavailable/);
    expect(() =>
      synthesizeRirChannels({ synthesizeRir: () => rirResult(new Float32Array([1])) }, 0, preset),
    ).toThrow(RangeError);
    expect(() =>
      synthesizeRirChannels({ synthesizeRir: () => rirResult(new Float32Array()) }, 48000, preset),
    ).toThrow(/failed/);
  });
});

describe('estimateRoomRange', () => {
  it('downmixes the range and summarizes the room estimate', () => {
    const estimateRoom = vi.fn((request: EstimateRoomRequest) => {
      const { samples, sampleRate, ...options } = request;
      expect([...samples]).toEqual([4, 5]);
      expect(sampleRate).toBe(48000);
      expect(options).toEqual({ mode: 'auto', nOctaveBands: 6 });
      return roomEstimateResult({
        volume: 120,
        lengthM: 6,
        widthM: 5,
        heightM: 4,
        drrDb: -8,
        confidence: 0.75,
        bandAbsorption: new Float32Array([0.2, 0.3]),
        rt60Bands: new Float32Array([0.4, 0.6, Number.NaN]),
      });
    });

    const summary = estimateRoomRange(
      { estimateRoom: estimateRoomFn(estimateRoom) },
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      48000,
      {
        startFrame: 1,
        endFrame: 3,
      },
    );

    expect(summary).toMatchObject({
      volume: 120,
      length: 6,
      width: 5,
      height: 4,
      drrDb: -8,
      confidence: 0.75,
    });
    expect(summary.rt60Mid).toBeCloseTo(0.5, 6);
    expect(summary.absorptionMean).toBeCloseTo(0.25, 6);
  });

  it('validates availability, sample rate and range', () => {
    const mod: SampleEditorWasmOps = {
      estimateRoom: () => roomEstimateResult(),
    };

    expect(() => estimateRoomRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => estimateRoomRange(mod, ch([1]), 0)).toThrow(RangeError);
    expect(() => estimateRoomRange(mod, ch([1, 2]), 48000, { startFrame: 1, endFrame: 1 })).toThrow(
      RangeError,
    );
    const summary = estimateRoomRange(mod, ch([1]), 48000);
    expect(summary.rt60Mid).toBeNaN();
    expect(summary.absorptionMean).toBeNaN();
  });

  it('converts room estimates into presets for roomMorph and RIR synthesis', () => {
    const base = {
      volume: 48,
      length: 6,
      width: 4,
      height: 2,
      drrDb: -8,
      confidence: 0.75,
      rt60Mid: 0.65,
    };
    expect(roomEstimateToPreset({ ...base, absorptionMean: 0.12 })).toEqual({
      lengthM: 6,
      widthM: 4,
      heightM: 2,
      materialPreset: 'concrete',
    });
    expect(roomEstimateToPreset({ ...base, absorptionMean: 0.52 })).toEqual({
      lengthM: 6,
      widthM: 4,
      heightM: 2,
      materialPreset: 'carpet',
    });
    expect(() => roomEstimateToPreset({ ...base, length: 0, absorptionMean: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('treats an estimate without a measurable decay as having no room shape', () => {
    const unmeasured = {
      volume: Number.NaN,
      length: Number.NaN,
      width: Number.NaN,
      height: Number.NaN,
      drrDb: -8,
      confidence: 0,
      rt60Mid: Number.NaN,
      absorptionMean: Number.NaN,
    };
    expect(roomEstimateHasGeometry(unmeasured)).toBe(false);
    expect(roomEstimateHasGeometry({ ...unmeasured, length: 6, width: 4, height: 2 })).toBe(true);
    expect(() => roomEstimateToPreset(unmeasured)).toThrow(RangeError);
  });
});

describe('acoustic analysis helpers', () => {
  const result = acousticResult({
    rt60: 0.8,
    edt: 0.5,
    c50: 3,
    c80: 4,
    d50: 0.6,
    rt60Bands: new Float32Array([0.7, 0.9, Number.NaN]),
    edtBands: new Float32Array([0.4, 0.6]),
    c50Bands: new Float32Array([2, 3]),
    c80Bands: new Float32Array([4, 5]),
    confidence: 0.8,
    isBlind: false,
  });

  it('analyzes a selected impulse response after downmixing', () => {
    const analyzeImpulseResponse = vi.fn((request: AnalyzeImpulseResponseRequest) => {
      const { samples, sampleRate, ...options } = request;
      expect([...samples]).toEqual([4, 5]);
      expect(sampleRate).toBe(48000);
      expect(options).toEqual({ nOctaveBands: 6 });
      return result;
    });

    const summary = analyzeImpulseResponseRange(
      { analyzeImpulseResponse: analyzeImpulseResponseFn(analyzeImpulseResponse) },
      ch([1, 2, 3, 4], [5, 6, 7, 8]),
      48000,
      { startFrame: 1, endFrame: 3 },
    );

    expect(summary).toMatchObject({
      kind: 'impulse',
      rt60: 0.8,
      edt: 0.5,
      c50: 3,
      c80: 4,
      d50: 0.6,
      confidence: 0.8,
      isBlind: false,
    });
    expect(summary.rt60Mean).toBeCloseTo(0.8, 6);
    expect(summary.edtMean).toBeCloseTo(0.5, 6);
  });

  it('runs blind acoustic detection with octave-band options', () => {
    const detectAcoustic = vi.fn((request: DetectAcousticRequest) => {
      const { samples, sampleRate, ...options } = request;
      expect([...samples]).toEqual([1]);
      expect(sampleRate).toBe(44100);
      expect(options).toEqual({ nOctaveBands: 6 });
      return { ...result, isBlind: true };
    });

    expect(
      detectAcousticRange({ detectAcoustic: detectAcousticFn(detectAcoustic) }, ch([1]), 44100),
    ).toMatchObject({
      kind: 'blind',
      isBlind: true,
    });
  });

  it('validates availability, sample rate and range', () => {
    const mod: SampleEditorWasmOps = {
      analyzeImpulseResponse: () => result,
      detectAcoustic: () => result,
    };

    expect(() => analyzeImpulseResponseRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => detectAcousticRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => analyzeImpulseResponseRange(mod, ch([1]), 0)).toThrow(RangeError);
    expect(() =>
      detectAcousticRange(mod, ch([1, 2]), 48000, { startFrame: 1, endFrame: 1 }),
    ).toThrow(RangeError);
  });
});

describe('restoreRange', () => {
  it('repairs a stereo pair as one linked pair inside the range', () => {
    const masterAudioStereo = vi.fn(({ left, right }: MasterAudioStereoRequest) =>
      masteringChainStereoResult(
        Float32Array.from(left, (value) => value * 10),
        Float32Array.from(right, (value) => value * 100),
      ),
    );
    const masterAudio = vi.fn((request: MasterAudioRequest) =>
      masteringChainResult(request.samples),
    );
    const out = restoreRange(
      { masterAudio: masterAudioFn(masterAudio), masterAudioStereo },
      ch([1, 2, 3], [4, 5, 6]),
      48000,
      'vinyl',
      { startFrame: 1, endFrame: 3 },
    );
    expect(plain(out)).toEqual([
      [1, 20, 30],
      [4, 500, 600],
    ]);
    expect(masterAudioStereo).toHaveBeenCalledWith({
      left: expect.any(Float32Array),
      right: expect.any(Float32Array),
      sampleRate: 48000,
      preset: 'vinyl',
    });
    expect(masterAudio).not.toHaveBeenCalled();
  });

  it('repairs other layouts channel by channel', () => {
    const masterAudio = vi.fn((request: MasterAudioRequest) =>
      masteringChainResult(Float32Array.from(request.samples, (value) => -value)),
    );
    const masterAudioStereo = vi.fn((request: MasterAudioStereoRequest) =>
      masteringChainStereoResult(request.left, request.right),
    );
    const out = restoreRange(
      { masterAudio: masterAudioFn(masterAudio), masterAudioStereo },
      ch([1, 2]),
      44100,
      'shellac78',
    );
    expect(plain(out)).toEqual([[-1, -2]]);
    expect(masterAudio).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 44100,
      preset: 'shellac78',
    });
  });

  it('throws when the module cannot run a preset', () => {
    expect(() => restoreRange({}, ch([1]), 48000, 'vinyl')).toThrow(/unavailable/);
  });
});

describe('stereo-linked repairs', () => {
  it('repairs a stereo pair through the linked form when the module has one', () => {
    const mono = vi.fn((request: MasteringRepairDeclickRequest) => declickResult(request.samples));
    const stereo = vi.fn(({ left, right }: MasteringRepairDeclickStereoRequest) =>
      declickStereoResult([Float32Array.from(left, () => 7), Float32Array.from(right, () => 8)]),
    );
    const out = declickRange(
      {
        masteringRepairDeclick: declickFn(mono),
        masteringRepairDeclickStereo: stereo,
      },
      ch([1, 2, 3], [4, 5, 6]),
      48000,
      { startFrame: 0, endFrame: 2 },
    );
    expect(plain(out)).toEqual([
      [7, 7, 3],
      [8, 8, 6],
    ]);
    expect(mono).not.toHaveBeenCalled();
    expect(stereo).toHaveBeenCalledWith({
      left: expect.any(Float32Array),
      right: expect.any(Float32Array),
      sampleRate: 48000,
    });
  });

  it('forwards the denoise depth to both the linked and the per-channel form', () => {
    const mono = vi.fn((request: MasteringRepairDenoiseClassicalRequest) =>
      denoiseResult(request.samples),
    );
    const stereo = vi.fn(({ left, right }: MasteringRepairDenoiseClassicalStereoRequest) =>
      denoiseStereoResult([left, right]),
    );
    const ops: SampleEditorWasmOps = {
      masteringRepairDenoiseClassical: denoiseClassicalFn(mono),
      masteringRepairDenoiseClassicalStereo: stereo,
    };
    denoiseRange(ops, ch([1], [2]), 48000, null, 18);
    expect(stereo).toHaveBeenCalledWith({
      left: expect.any(Float32Array),
      right: expect.any(Float32Array),
      sampleRate: 48000,
      reductionDb: 18,
    });
    denoiseRange(ops, ch([1]), 48000, null, 12);
    expect(mono).toHaveBeenCalledWith({
      samples: expect.any(Float32Array),
      sampleRate: 48000,
      reductionDb: 12,
    });
  });
});

describe('against the real core', () => {
  const ops: SampleEditorWasmOps = core;
  const sampleRate = 22050;
  const preset = { lengthM: 4, widthM: 3, heightM: 2.6, materialPreset: 'wood' as const };
  const range = { startFrame: 2000, endFrame: 12000 };
  // Clear of the first 1000 frames by more than an STFT window.
  const spectralRange = { startFrame: 6000, endFrame: 14000 };

  /** A seeded noise burst with an exponential decay: a usable stand-in for an impulse response. */
  function decayingNoise(frames: number): Float32Array {
    let state = 12345;
    return Float32Array.from({ length: frames }, (_, i) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return ((state / 0xffffffff) * 2 - 1) * Math.exp((-6 * i) / frames);
    });
  }

  const tone = Float32Array.from(
    { length: sampleRate },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate),
  );
  const stereoTone = [tone, Float32Array.from(tone, (v) => v * 0.5)];

  /**
   * The span the op touched changed and the first 1000 frames did not, to
   * `tolerance` (a spectral edit reconstructs the whole buffer from an STFT).
   */
  function expectSpanEdited(
    out: Float32Array[],
    span: { startFrame: number; endFrame: number } = range,
    tolerance = 0,
  ) {
    expect(out).toHaveLength(stereoTone.length);
    out.forEach((channel, index) => {
      expect(channel.every(Number.isFinite)).toBe(true);
      for (let frame = 0; frame < 1000; frame += 1) {
        expect(Math.abs(channel[frame] - stereoTone[index][frame])).toBeLessThanOrEqual(tolerance);
      }
    });
    const inside = (channel: Float32Array) => [
      ...channel.slice(span.startFrame + 100, span.endFrame - 100),
    ];
    expect(inside(out[0])).not.toEqual(inside(stereoTone[0]));
  }

  beforeAll(async () => {
    await core.init({ wasmBinary: coreWasmBinary() });
  });

  it('shifts pitch through the request the core accepts', () => {
    expectSpanEdited(pitchShiftRange(ops, stereoTone, sampleRate, 3, range));
  });

  it('retunes to a MIDI note after tracking the source pitch', () => {
    expect(estimateSourceMidi(ops, tone, sampleRate)).toBeCloseTo(69, 0);
    expectSpanEdited(pitchCorrectRange(ops, stereoTone, sampleRate, 72, range));
  });

  it('retunes to the nearest scale degree', () => {
    expectSpanEdited(scaleCorrectRange(ops, stereoTone, sampleRate, 0, 0b101010110101, range));
  });

  it('estimates and corrects the tuning offset', () => {
    const out = tuneToReferenceRange(ops, stereoTone, sampleRate, range);
    expect(out).toHaveLength(2);
    expect(out[0].every(Number.isFinite)).toBe(true);
  });

  it('runs the time-varying corrector on the pYIN contour', () => {
    expectSpanEdited(pitchCorrectTimevaryingRange(ops, stereoTone, sampleRate, 72, range));
  });

  it('runs auto-tune and reports the key it used', () => {
    const out = autoTuneRange(ops, stereoTone, sampleRate, 'detect', 0.8, range);
    expect(out.channels).toHaveLength(2);
    expect(out.key.root).toBeGreaterThanOrEqual(0);
  });

  it('changes the voice with pitch and formant settings', () => {
    expectSpanEdited(voiceChangeRange(ops, stereoTone, sampleRate, 2, 1, 'relative', range));
  });

  it('separates harmonic and percussive content', () => {
    expect(harmonicRange(ops, stereoTone, sampleRate, range)).toHaveLength(2);
    expect(percussiveRange(ops, stereoTone, sampleRate, range)).toHaveLength(2);
  });

  it('stretches time and notes', () => {
    const stretched = timeStretchRange(ops, stereoTone, sampleRate, 2, range);
    expect(stretched[0].length).toBeLessThan(tone.length);
    const noteStretched = noteStretchRange(ops, [tone], sampleRate, 2, range);
    expect(noteStretched[0].length).toBeLessThan(tone.length);
    expect(noteMoveRange(ops, [tone], sampleRate, 500, range)[0].every(Number.isFinite)).toBe(true);
  });

  it('applies spectral edits', () => {
    expectSpanEdited(
      spectralDenoiseRange(ops, stereoTone, sampleRate, spectralRange),
      spectralRange,
      1e-6,
    );
    const edited = spectralEditRange(ops, stereoTone, sampleRate, spectralRange, {
      lowHz: 300,
      highHz: 600,
      gainDb: -20,
      mode: 'attenuate',
    });
    expectSpanEdited(edited, spectralRange, 1e-6);
  });

  it('runs every repair processor through its linked or per-channel form', () => {
    for (const repair of [
      declickRange,
      denoiseRange,
      declipRange,
      decrackleRange,
      dehumRange,
      dereverbRange,
    ]) {
      const out = repair(ops, stereoTone, sampleRate, range);
      expect(out).toHaveLength(2);
      expect(out[0].every(Number.isFinite)).toBe(true);
    }
    const mono = [tone];
    expect(denoiseRange(ops, mono, sampleRate, range, 12)).toHaveLength(1);
    expect(declickRange(ops, mono, sampleRate, range)).toHaveLength(1);
  });

  it('trims the silence around a signal', () => {
    const padded = new Float32Array(sampleRate);
    padded.set(tone.slice(0, 4000), 8000);
    const out = trimSilenceRange(ops, [padded], sampleRate);
    expect(out[0].length).toBeLessThan(padded.length);
  });

  it('analyzes the repair needs of a range and applies stages', () => {
    expect(analyzeRepairRange(ops, stereoTone, sampleRate, range).recommended).toBeInstanceOf(
      Array,
    );
    const out = repairStagesRange(ops, stereoTone, sampleRate, [{ stage: 'declick' }], range);
    expect(out).toHaveLength(2);
  });

  it('restores a stereo pair and a mono channel with a preset', () => {
    expect(restoreRange(ops, stereoTone, sampleRate, 'vinyl', range)).toHaveLength(2);
    expect(restoreRange(ops, [tone], sampleRate, 'vinyl', range)).toHaveLength(1);
  });

  it('finds onsets, silence splits and note regions', () => {
    const burst = new Float32Array(sampleRate);
    burst.set(tone.slice(0, 4000), 4000);
    burst.set(tone.slice(0, 4000), 14000);
    expect(detectOnsetFrames(ops, [burst], sampleRate).length).toBeGreaterThan(0);
    expect(splitSilenceFrames(ops, [burst], sampleRate, 30).length).toBeGreaterThan(0);
    const notes = detectNoteRegions(ops, [tone], sampleRate);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].midi).toBeCloseTo(69, 0);
  });

  it('matches the EQ of a range to a reference and analyzes the match', () => {
    const reference = Float32Array.from(tone, (v, i) => v + 0.2 * Math.sin(i / 3));
    expectSpanEdited(
      matchEqToReference(ops, stereoTone, sampleRate, reference, range, 1, sampleRate),
    );
    const analysis = analyzeMatchEqToReference(ops, stereoTone, sampleRate, reference, range);
    expect(analysis.curve.frequencies.length).toBe(analysis.curve.gainDb.length);
  });

  it('morphs room acoustics for stereo and mono layouts and synthesizes a RIR', () => {
    const clip = [tone.slice(0, 4000), stereoTone[1].slice(0, 4000)];
    const largeRoom = { lengthM: 9, widthM: 7, heightM: 3.5, materialPreset: 'carpet' as const };
    expect(roomMorphChannels(ops, clip, sampleRate, largeRoom, 0.5).channels).toHaveLength(2);
    expect(
      roomMorphChannels(ops, [clip[0]], sampleRate, largeRoom, 0.5, true).channels,
    ).toHaveLength(1);
    expect(synthesizeRirChannels(ops, sampleRate, largeRoom).channels[0].length).toBeGreaterThan(0);
  }, 30_000);

  // The editor's default "small room" preset passes no placement, so the core
  // places the source and listener inside the room.
  it('morphs a stereo pair into the small-room preset', () => {
    expect(roomMorphChannels(ops, stereoTone, sampleRate, preset, 0.5).channels).toHaveLength(2);
  });

  it('synthesizes the small-room preset RIR', () => {
    expect(synthesizeRirChannels(ops, sampleRate, preset).channels[0].length).toBeGreaterThan(0);
  });

  it('morphs a mono clip into the small-room preset', () => {
    expect(roomMorphChannels(ops, [tone], sampleRate, preset, 0.5).channels).toHaveLength(1);
  });

  it('measures an impulse response and a blind acoustic estimate', () => {
    const impulse = decayingNoise(sampleRate);
    const measured = analyzeImpulseResponseRange(ops, [impulse], sampleRate);
    expect(measured.kind).toBe('impulse');
    expect(measured.rt60).toBeGreaterThan(0);
    expect(detectAcousticRange(ops, [impulse], sampleRate).kind).toBe('blind');
    const room = estimateRoomRange(ops, [impulse], sampleRate);
    expect(Number.isNaN(room.confidence)).toBe(false);
  });
});

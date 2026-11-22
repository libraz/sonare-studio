import type {
  AnalyzeImpulseResponseRequest,
  DetectAcousticRequest,
  EstimateRoomRequest,
  RirDiagnostic,
  RoomMorphRequest,
  RoomMorphStereoRequest,
  SynthesizeRirRequest,
} from '@libraz/libsonare';
import * as core from '@libraz/libsonare';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  analyzeImpulseResponseRange,
  detectAcousticRange,
  estimateRoomRange,
  roomEstimateHasGeometry,
  roomEstimateToPreset,
  roomMorphChannels,
  synthesizeRirChannels,
} from '@/ui/sample-editor/room-acoustics';
import type { SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';
import { coreWasmBinary } from './core-package';
import {
  acousticResult,
  analyzeImpulseResponseFn,
  detectAcousticFn,
  estimateRoomFn,
  rirResult,
  roomEstimateResult,
  roomMorphFn,
  roomMorphResult,
  roomMorphStereoResult,
} from './fakes/analysis';

/** Shorthand: plain number arrays to planar Float32Array channels. */
function ch(...channels: number[][]): Float32Array[] {
  return channels.map((c) => new Float32Array(c));
}

/** Shorthand: planar channels back to plain number arrays. */
function plain(channels: ReadonlyArray<Float32Array>): number[][] {
  return channels.map((c) => [...c]);
}

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

describe('against the real core', () => {
  const ops: SampleEditorWasmOps = core;
  const sampleRate = 22050;
  const preset = { lengthM: 4, widthM: 3, heightM: 2.6, materialPreset: 'wood' as const };

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

  beforeAll(async () => {
    await core.init({ wasmBinary: coreWasmBinary() });
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

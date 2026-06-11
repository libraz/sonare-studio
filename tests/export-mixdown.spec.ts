import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPrerenderCache } from '@/engine/instruments';
import {
  type MasteringDeps,
  MixdownCancelledError,
  type MixdownDeps,
  renderMixdown,
} from '@/export/mixdown';
import { dbToLinear } from '@/project/mixer';
import type { StripProcessorDeps } from '@/project/mixer-dsp';
import { clearStripProcessingCache } from '@/project/scheduling';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/**
 * All documents render at 10 Hz with tempo 120: 1 PPQ = 0.5 s = 5 frames, so
 * a lengthPpq of 0.4 maps to exactly 2 frames.
 */
const SAMPLE_RATE = 10;

function makeDoc(
  tracks: DocumentTrack[],
  overrides: Partial<ProjectDocument> = {},
): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Mixdown test',
    sampleRate: SAMPLE_RATE,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    tracks,
    markers: [],
    sections: [],
    ...overrides,
  };
}

function makeTrack(clips: DocumentClip[], overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'Track',
    color: '#60a5fa',
    kind: 'audio',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips,
    ...overrides,
  };
}

let nextAssetId = 1;

function makeAudioClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'Audio clip',
    startPpq: 0,
    lengthPpq: 0.4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: `asset-${nextAssetId++}`,
    ...overrides,
  };
}

function makeMidiClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'MIDI clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
    kind: 'midi',
    ...overrides,
  };
}

/** Stub asset loader: 8 stereo frames of 0.5 at 10 Hz, regardless of id. */
function makeAssetLoader(value = 0.5, frames = 8) {
  return vi.fn(async (assetId: string) => ({
    meta: {
      id: assetId,
      name: assetId,
      sampleRate: SAMPLE_RATE,
      numChannels: 2,
      numFrames: frames,
    },
    channels: [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)],
  }));
}

/** Pass-through-with-marker strip deps adding +0.25 per processStereo run. */
function markerStripDeps(): StripProcessorDeps & { processStereo: ReturnType<typeof vi.fn> } {
  return {
    processStereo: vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: left.map((x) => x + 0.25),
      right: right.map((x) => x + 0.25),
    })),
  };
}

/** Mastering deps: preset doubles, processors add +0.25, both spied. */
function markerMasteringDeps(): MasteringDeps & {
  processStereo: ReturnType<typeof vi.fn>;
  applyPreset: ReturnType<typeof vi.fn>;
} {
  return {
    processStereo: vi.fn(
      (
        _name: string,
        left: Float32Array,
        right: Float32Array,
        _sampleRate: number,
        _params: Record<string, number | boolean>,
      ) => ({
        left: left.map((x) => x + 0.25),
        right: right.map((x) => x + 0.25),
      }),
    ),
    applyPreset: vi.fn((_preset: string, left: Float32Array, right: Float32Array) => ({
      left: left.map((x) => x * 2),
      right: right.map((x) => x * 2),
    })),
  };
}

function pureDeps(overrides: Partial<MixdownDeps> = {}): MixdownDeps {
  return { stripDsp: null, mastering: null, metering: null, ...overrides };
}

describe('renderMixdown', () => {
  beforeEach(() => {
    clearStripProcessingCache();
    clearPrerenderCache();
  });

  describe('clip placement and summing', () => {
    it('places an audio clip at its timeline frame offset', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip({ startPpq: 1 })])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.sampleRate).toBe(SAMPLE_RATE);
      expect(result.totalFrames).toBe(7); // 5 offset + 2 content frames
      expect(Array.from(result.channels[0].slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
      expect(result.channels[0][5]).toBeCloseTo(0.5, 6);
      expect(result.channels[1][6]).toBeCloseTo(0.5, 6);
    });

    it('sums overlapping clips additively', async () => {
      const doc = makeDoc([
        makeTrack([makeAudioClip({ startPpq: 0 })]),
        makeTrack([makeAudioClip({ startPpq: 0 })]),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.channels[0][0]).toBeCloseTo(1, 6);
      expect(result.channels[1][1]).toBeCloseTo(1, 6);
    });

    it('multiplies track volume, clip gain and strip gain into audio clips', async () => {
      const doc = makeDoc([
        makeTrack([makeAudioClip({ gain: 0.8 })], {
          volume: 0.5,
          mixer: { gainDb: 6, pan: 0, inserts: [], sends: [] },
        }),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.channels[0][0]).toBeCloseTo(0.5 * 0.5 * 0.8 * dbToLinear(6), 6);
    });

    it('skips clips with missing assets silently', async () => {
      const loader = vi.fn(async () => {
        throw new Error('not stored');
      });
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      const result = await renderMixdown(doc, { deps: pureDeps(), loadAudioAsset: loader });
      expect(result.totalFrames).toBe(0);
    });

    it('bakes audio clip fades into the rendered window', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip({ fadeInPpq: 0.4 })])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.channels[0][0]).toBeCloseTo(0, 6);
      expect(result.channels[0][1]).toBeCloseTo(0.25, 6);
    });
  });

  describe('mute and solo', () => {
    it('renders muted tracks silent', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()], { mute: true })]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.totalFrames).toBe(0);
      expect(result.report.peakDb).toBe(Number.NEGATIVE_INFINITY);
    });

    it('keeps only soloed tracks when any solo is active', async () => {
      const doc = makeDoc([
        makeTrack([makeAudioClip({ startPpq: 0 })], { solo: true }),
        makeTrack([makeAudioClip({ startPpq: 1 })]),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.totalFrames).toBe(2); // only the soloed clip contributes
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
    });

    it('mute wins over the track own solo', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()], { mute: true, solo: true })]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.totalFrames).toBe(0);
    });
  });

  describe('range windows', () => {
    it('cuts an explicit PPQ window, including clips that started earlier', async () => {
      // 8 frames of content from PPQ 0; the window [1, 2) covers frames 5..10.
      const doc = makeDoc([makeTrack([makeAudioClip({ lengthPpq: 1.6 })])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
        range: { startPpq: 1, endPpq: 2 },
      });
      expect(result.totalFrames).toBe(5);
      // Asset frames 5..7 land at window frames 0..2; the rest is silence.
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
      expect(result.channels[0][2]).toBeCloseTo(0.5, 6);
      expect(result.channels[0][3]).toBeCloseTo(0, 6);
      expect(result.channels[0][4]).toBeCloseTo(0, 6);
    });

    it('skips clips starting at or after the window end', async () => {
      const loader = makeAssetLoader();
      const doc = makeDoc([
        makeTrack([makeAudioClip({ startPpq: 0 }), makeAudioClip({ startPpq: 3 })]),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: loader,
        range: { startPpq: 0, endPpq: 1 },
      });
      expect(result.totalFrames).toBe(5);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("renders the loop window via range 'loop'", async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
        range: 'loop',
        loopRegion: { startPpq: 0, endPpq: 2 },
      });
      expect(result.totalFrames).toBe(10);
    });

    it("rejects range 'loop' without a loop region", async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      await expect(
        renderMixdown(doc, { deps: pureDeps(), loadAudioAsset: makeAssetLoader(), range: 'loop' }),
      ).rejects.toThrow(RangeError);
    });

    it('rejects inverted explicit ranges', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      await expect(
        renderMixdown(doc, {
          deps: pureDeps(),
          loadAudioAsset: makeAssetLoader(),
          range: { startPpq: 2, endPpq: 1 },
        }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('MIDI clips', () => {
    it('prerenders through the wasm instrument and normalizes to the target peak', async () => {
      // The fake wasm bounce renders 3 stereo frames peaking at 0.75.
      const doc = makeDoc([makeTrack([makeMidiClip()], { kind: 'midi', volume: 0.5 })]);
      const result = await renderMixdown(doc, { deps: pureDeps() });
      expect(result.totalFrames).toBe(3);
      // targetPeak = 0.5 (default) * volume 0.5 = 0.25; render peak 0.75 -> gain 1/3.
      expect(result.channels[0][0]).toBeCloseTo(0.25 / 3, 6);
      expect(result.channels[1][2]).toBeCloseTo(-0.25, 6);
    });

    it('mixes at the rendered level when targetPeak is null', async () => {
      const doc = makeDoc([makeTrack([makeMidiClip()], { kind: 'midi', volume: 0.5 })]);
      const result = await renderMixdown(doc, { deps: pureDeps(), targetPeak: null });
      expect(result.channels[0][0]).toBeCloseTo(0.25, 6);
    });

    it('skips clips whose audible window holds no notes', async () => {
      const doc = makeDoc([makeTrack([makeMidiClip({ sourceOffsetPpq: 8 })], { kind: 'midi' })]);
      const result = await renderMixdown(doc, { deps: pureDeps() });
      expect(result.totalFrames).toBe(0);
    });
  });

  describe('strip DSP and pan', () => {
    it('applies track inserts through the strip seam', async () => {
      const deps = markerStripDeps();
      const doc = makeDoc([
        makeTrack([makeAudioClip()], {
          mixer: {
            gainDb: 0,
            pan: 0,
            inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: true }],
            sends: [],
          },
        }),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps({ stripDsp: deps }),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(deps.processStereo).toHaveBeenCalledTimes(1);
      expect(result.channels[0][0]).toBeCloseTo(0.75, 6);
    });

    it('bakes the strip pan as a balance law', async () => {
      const doc = makeDoc([
        makeTrack([makeAudioClip()], {
          mixer: { gainDb: 0, pan: -0.5, inserts: [], sends: [] },
        }),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
      expect(result.channels[1][0]).toBeCloseTo(0.25, 6);
    });
  });

  describe('master stage', () => {
    function masterDoc(overrides: Partial<NonNullable<ProjectDocument['mixer']>> = {}) {
      return makeDoc([makeTrack([makeAudioClip()]), makeTrack([makeAudioClip()])], {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          ...overrides,
        },
      });
    }

    it('applies master gain and pan on the summed bus', async () => {
      const doc = masterDoc({ master: { gainDb: -6, pan: 0.5, inserts: [], sends: [] } });
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      const gain = dbToLinear(-6);
      expect(result.channels[0][0]).toBeCloseTo(1 * gain * 0.5, 6); // left attenuated by pan
      expect(result.channels[1][0]).toBeCloseTo(1 * gain, 6);
    });

    it('applies master inserts once to the summed bus', async () => {
      const deps = markerStripDeps();
      const doc = masterDoc({
        master: {
          gainDb: 0,
          pan: 0,
          inserts: [{ processor: 'dynamics.compressor', params: {}, enabled: true }],
          sends: [],
        },
      });
      const result = await renderMixdown(doc, {
        deps: pureDeps({ stripDsp: deps }),
        loadAudioAsset: makeAssetLoader(),
      });
      // Two 0.5 clips sum to 1.0, then one marker pass adds 0.25.
      expect(deps.processStereo).toHaveBeenCalledTimes(1);
      expect(result.channels[0][0]).toBeCloseTo(1.25, 6);
    });

    it('skips master inserts when includeMasterChain is false but keeps gain/pan', async () => {
      const deps = markerStripDeps();
      const doc = masterDoc({
        master: {
          gainDb: -6,
          pan: 0,
          inserts: [{ processor: 'dynamics.compressor', params: {}, enabled: true }],
          sends: [],
        },
      });
      const result = await renderMixdown(doc, {
        deps: pureDeps({ stripDsp: deps }),
        loadAudioAsset: makeAssetLoader(),
        includeMasterChain: false,
      });
      expect(deps.processStereo).not.toHaveBeenCalled();
      expect(result.channels[0][0]).toBeCloseTo(dbToLinear(-6), 6);
    });
  });

  describe('mastering chain', () => {
    function chainDoc(): ProjectDocument {
      return makeDoc([makeTrack([makeAudioClip()])], {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          masteringChain: {
            preset: 'pop',
            processors: [
              { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
              { processor: 'eq.tilt', params: {}, enabled: false },
            ],
          },
        },
      });
    }

    it('applies the preset, then the enabled processors, in order', async () => {
      const mastering = markerMasteringDeps();
      const result = await renderMixdown(chainDoc(), {
        deps: pureDeps({ mastering }),
        loadAudioAsset: makeAssetLoader(),
      });
      // 0.5 doubled by the preset, then +0.25 by the enabled processor.
      expect(result.channels[0][0]).toBeCloseTo(1.25, 6);
      expect(mastering.applyPreset).toHaveBeenCalledTimes(1);
      expect(mastering.applyPreset.mock.calls[0][0]).toBe('pop');
      expect(mastering.processStereo).toHaveBeenCalledTimes(1);
      expect(mastering.processStereo.mock.calls[0][0]).toBe('maximizer.truePeakLimiter');
      expect(mastering.processStereo.mock.calls[0][4]).toEqual({ ceilingDb: -1 });
      // The preset ran before the processor (call order across the two spies).
      expect(mastering.applyPreset.mock.invocationCallOrder[0]).toBeLessThan(
        mastering.processStereo.mock.invocationCallOrder[0],
      );
    });

    it('skips the whole chain when includeMasterChain is false', async () => {
      const mastering = markerMasteringDeps();
      const result = await renderMixdown(chainDoc(), {
        deps: pureDeps({ mastering }),
        loadAudioAsset: makeAssetLoader(),
        includeMasterChain: false,
      });
      expect(mastering.applyPreset).not.toHaveBeenCalled();
      expect(mastering.processStereo).not.toHaveBeenCalled();
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
    });

    it('skips the chain without a mastering seam', async () => {
      const result = await renderMixdown(chainDoc(), {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
    });

    it('runs processors without a preset when only slots are configured', async () => {
      const mastering = markerMasteringDeps();
      const doc = makeDoc([makeTrack([makeAudioClip()])], {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          masteringChain: {
            processors: [{ processor: 'saturation.tape', params: {}, enabled: true }],
          },
        },
      });
      const result = await renderMixdown(doc, {
        deps: pureDeps({ mastering }),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(mastering.applyPreset).not.toHaveBeenCalled();
      expect(result.channels[0][0]).toBeCloseTo(0.75, 6);
    });
  });

  describe('stems', () => {
    it('returns post-strip pre-master stems plus the processed mixdown', async () => {
      const doc = makeDoc(
        [
          makeTrack([makeAudioClip()], { name: 'Drums' }),
          makeTrack([makeAudioClip()], { name: 'Bass' }),
        ],
        {
          mixer: {
            master: { gainDb: -6, pan: 0, inserts: [], sends: [] },
            buses: [],
          },
        },
      );
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
        stems: true,
      });
      expect(result.stems).toHaveLength(2);
      expect(result.stems?.[0]).toMatchObject({ trackIndex: 0, name: 'Drums' });
      expect(result.stems?.[1]).toMatchObject({ trackIndex: 1, name: 'Bass' });
      // Stems carry no master gain; the mixdown is their sum with it applied.
      expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.5, 6);
      expect(result.channels[0][0]).toBeCloseTo(1 * dbToLinear(-6), 6);
    });

    it('omits stems for muted tracks', async () => {
      const doc = makeDoc([
        makeTrack([makeAudioClip()], { name: 'On' }),
        makeTrack([makeAudioClip()], { name: 'Off', mute: true }),
      ]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
        stems: true,
      });
      expect(result.stems?.map((stem) => stem.name)).toEqual(['On']);
    });
  });

  describe('progress and cancellation', () => {
    it('reports monotonic progress with clip and stage names', async () => {
      const stages: Array<[number, string]> = [];
      const doc = makeDoc([makeTrack([makeAudioClip(), makeAudioClip({ startPpq: 1 })])], {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          masteringChain: {
            processors: [{ processor: 'saturation.tape', params: {}, enabled: true }],
          },
        },
      });
      await renderMixdown(doc, {
        deps: pureDeps({ mastering: markerMasteringDeps() }),
        loadAudioAsset: makeAssetLoader(),
        onProgress: (progress, stage) => stages.push([progress, stage]),
      });
      expect(stages.map(([, stage]) => stage)).toEqual([
        'clip:0:0',
        'clip:0:1',
        'master.strip',
        'mastering.saturation.tape',
        'metering',
        'done',
      ]);
      expect(stages[0][0]).toBe(0);
      expect(stages[stages.length - 1][0]).toBe(1);
      for (let i = 1; i < stages.length; i++) {
        expect(stages[i][0]).toBeGreaterThanOrEqual(stages[i - 1][0]);
      }
    });

    it('aborts with MixdownCancelledError when shouldCancel flips', async () => {
      let calls = 0;
      const doc = makeDoc([makeTrack([makeAudioClip(), makeAudioClip({ startPpq: 1 })])]);
      await expect(
        renderMixdown(doc, {
          deps: pureDeps(),
          loadAudioAsset: makeAssetLoader(),
          shouldCancel: () => {
            calls += 1;
            return calls > 1; // cancel after the first clip
          },
        }),
      ).rejects.toBeInstanceOf(MixdownCancelledError);
    });

    it('awaits the yield hook between clips', async () => {
      const yieldHook = vi.fn(async () => {});
      const doc = makeDoc([makeTrack([makeAudioClip(), makeAudioClip({ startPpq: 1 })])]);
      await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
        yieldBetweenClips: yieldHook,
      });
      expect(yieldHook).toHaveBeenCalledTimes(2);
    });
  });

  describe('report', () => {
    it('always reports the sample peak in dBFS', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps(),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.5), 5);
      expect(result.report.truePeakDb).toBeUndefined();
      expect(result.report.lufs).toBeUndefined();
    });

    it('adds true peak and loudness through the metering seam', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps({
          metering: {
            truePeakDb: () => -5.5,
            integratedLufs: () => -14.2,
          },
        }),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.report.truePeakDb).toBeCloseTo(-5.5, 6);
      expect(result.report.lufs).toBeCloseTo(-14.2, 6);
    });

    it('drops metering fields when the seam throws', async () => {
      const doc = makeDoc([makeTrack([makeAudioClip()])]);
      const result = await renderMixdown(doc, {
        deps: pureDeps({
          metering: {
            truePeakDb: () => {
              throw new Error('boom');
            },
            integratedLufs: () => {
              throw new Error('boom');
            },
          },
        }),
        loadAudioAsset: makeAssetLoader(),
      });
      expect(result.report.truePeakDb).toBeUndefined();
      expect(result.report.lufs).toBeUndefined();
      expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.5), 5);
    });
  });

  describe('wasm-derived deps', () => {
    it('derives metering and mastering seams from the fake wasm module', async () => {
      // deps omitted: derived from the mocked ensureWasm module.
      const doc = makeDoc([makeTrack([makeAudioClip()])], {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          masteringChain: { preset: 'pop', processors: [] },
        },
      });
      const result = await renderMixdown(doc, { loadAudioAsset: makeAssetLoader() });
      // The fake masterAudioStereo passes audio through unchanged.
      expect(result.channels[0][0]).toBeCloseTo(0.5, 6);
      // The fake metering one-shots report the sample peak and an energy LUFS.
      expect(result.report.truePeakDb).toBeCloseTo(20 * Math.log10(0.5), 5);
      expect(typeof result.report.lufs).toBe('number');
    });
  });
});

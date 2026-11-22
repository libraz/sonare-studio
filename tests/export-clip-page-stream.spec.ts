import * as core from '@libraz/libsonare';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetClipPageBindingFactory } from '@/export/clip-page-binding';
import {
  audioClipSegmentKey,
  frozenTrackStreamKey,
  planAudioClipStreams,
} from '@/export/clip-page-plan';
import {
  AudioClipStreamSession,
  CLIP_STREAM_WINDOW_PAGES,
  type ClipPageBinding,
  type ClipPageBindingFactory,
  ClipPageReadError,
  clipStreamPageBudgetBytes,
  clipStreamPageFrames,
  MAX_CLIP_STREAM_PAGE_BYTES,
  MIN_CLIP_STREAM_PAGE_BYTES,
} from '@/export/clip-page-stream';
import { buildAudioClips, preflightAudioClipMemory } from '@/export/engine-render-clips';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { sliceAudioClipWindow } from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';
import { coreWasmBinary } from './core-package';
import {
  recordedClipPageProviders,
  resetRecordedClipPageProviders,
} from './recording-clip-page-provider';

vi.mock('@libraz/libsonare', async (importOriginal) => {
  const { withRecordingClipPageProvider } = await import('./recording-clip-page-provider');
  return withRecordingClipPageProvider(await importOriginal());
});

const SAMPLE_RATE = 48000;
/** 20 s at 120 BPM: comfortably past the streaming length floor. */
const ASSET_FRAMES = SAMPLE_RATE * 20;

const tempoMap = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);

function meta(overrides: Partial<AudioAssetMeta> = {}): AudioAssetMeta {
  return {
    id: 'asset-1',
    name: 'take.wav',
    sampleRate: SAMPLE_RATE,
    numChannels: 2,
    numFrames: ASSET_FRAMES,
    ...overrides,
  };
}

function audioClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'take',
    kind: 'audio',
    assetId: 'asset-1',
    startPpq: 4,
    // 30 quarter notes at 120 BPM = 15 s, inside the 20 s asset.
    lengthPpq: 30,
    sourceOffsetPpq: 0,
    gain: 0.8,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    ...overrides,
  } as DocumentClip;
}

function docWith(
  clips: DocumentClip[],
  trackOverrides: Record<string, unknown> = {},
): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'clip-page-stream',
    sampleRate: SAMPLE_RATE,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    tracks: [
      {
        name: 'Audio',
        color: '#fff',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips,
        ...trackOverrides,
      },
    ],
  } as unknown as ProjectDocument;
}

function planContext(overrides: Record<string, unknown> = {}) {
  return {
    trackIds: [1],
    tempoMap,
    sampleRate: SAMPLE_RATE,
    loadAudioMeta: async () => meta(),
    checkCancel: () => undefined,
    ...overrides,
  };
}

describe('planAudioClipStreams', () => {
  it('plans a long untransformed clip with the window playback would cut', async () => {
    const clip = audioClip({ sourceOffsetPpq: 6 });
    const plans = await planAudioClipStreams(docWith([clip]), planContext());
    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan.key).toBe(audioClipSegmentKey(0, 0, 0));
    expect(plan.trackId).toBe(1);
    expect(plan.assetId).toBe('asset-1');
    expect(plan.startPpq).toBe(4);
    expect(plan.gain).toBe(0.8);
    expect(plan.numChannels).toBe(2);
    // The paged window must be the very range the decoded path would slice.
    const sliced = sliceAudioClipWindow(
      [new Float32Array(ASSET_FRAMES), new Float32Array(ASSET_FRAMES)],
      SAMPLE_RATE,
      6,
      30,
      tempoMap,
      4 - 6,
    );
    expect(plan.frameCount).toBe(sliced[0].length);
    // One quarter note is 24000 frames at 120 BPM / 48 kHz.
    expect(plan.sourceStartFrame).toBe(6 * 24000);
    expect(plan.frameCount).toBe(30 * 24000);
    expect(plan.timelineStartFrame).toBe(4 * 24000);
  });

  it('leaves a clip the renderer would transform on the decoded path', async () => {
    const cases: Array<[string, DocumentClip]> = [
      ['fade in', audioClip({ fadeInPpq: 1 })],
      ['fade out', audioClip({ fadeOutPpq: 1 })],
      ['warp', audioClip({ warp: { enabled: true, sourceBpm: 100 } } as Partial<DocumentClip>)],
      ['silent', audioClip({ gain: 0 })],
    ];
    for (const [label, clip] of cases) {
      expect(await planAudioClipStreams(docWith([clip]), planContext()), label).toEqual([]);
    }
  });

  it('leaves a clip whose asset rate differs from the render rate', async () => {
    const plans = await planAudioClipStreams(
      docWith([audioClip()]),
      planContext({ loadAudioMeta: async () => meta({ sampleRate: 44100 }) }),
    );
    expect(plans).toEqual([]);
  });

  it('leaves clips shorter than the streaming floor and unreadable assets', async () => {
    expect(
      await planAudioClipStreams(docWith([audioClip({ lengthPpq: 1 })]), planContext()),
    ).toEqual([]);
    expect(
      await planAudioClipStreams(
        docWith([audioClip()]),
        planContext({
          loadAudioMeta: async () => {
            throw new Error('missing');
          },
        }),
      ),
    ).toEqual([]);
  });

  it('plans a frozen track from the timeline start and skips its clips', async () => {
    const doc = docWith([audioClip()], { frozen: { assetId: 'frozen-1' } });
    const plans = await planAudioClipStreams(
      doc,
      planContext({ loadAudioMeta: async (id: string) => meta({ id }) }),
    );
    expect(plans).toEqual([
      expect.objectContaining({
        key: frozenTrackStreamKey(0),
        assetId: 'frozen-1',
        startPpq: 0,
        gain: 1,
        sourceStartFrame: 0,
        frameCount: ASSET_FRAMES,
        timelineStartFrame: 0,
      }),
    ]);
  });

  it('skips tracks the render cannot hear', async () => {
    const plans = await planAudioClipStreams(
      docWith([audioClip()]),
      planContext({ audibleTrackIndices: new Set<number>() }),
    );
    expect(plans).toEqual([]);
  });

  it('reads each asset sidecar once', async () => {
    const loadAudioMeta = vi.fn(async () => meta());
    await planAudioClipStreams(
      docWith([audioClip(), audioClip({ startPpq: 64 })]),
      planContext({ loadAudioMeta }),
    );
    expect(loadAudioMeta).toHaveBeenCalledTimes(1);
  });
});

describe('planned clips leave the decoded path', () => {
  const buildContext = (streamedKeys: ReadonlySet<string>) => ({
    trackIds: [1],
    tempoMap,
    sampleRate: SAMPLE_RATE,
    loadAudio: async (): Promise<LoadedAudioAsset> => ({
      meta: meta(),
      channels: [new Float32Array(ASSET_FRAMES), new Float32Array(ASSET_FRAMES)],
    }),
    resampleAudio: (samples: Float32Array) => samples,
    checkCancel: () => undefined,
    streamedKeys,
  });

  it('builds nothing for a streamed segment and still builds the others', async () => {
    const doc = docWith([audioClip(), audioClip({ startPpq: 64 })]);
    const streamedKeys = new Set([audioClipSegmentKey(0, 0, 0)]);
    const clips = await buildAudioClips(doc, buildContext(streamedKeys));
    expect(clips).toHaveLength(1);
    expect(clips[0].startPpq).toBe(64);
    expect(await buildAudioClips(doc, buildContext(new Set()))).toHaveLength(2);
  });

  it('builds nothing for a streamed frozen track', async () => {
    const doc = docWith([], { frozen: { assetId: 'frozen-1' } });
    expect(
      await buildAudioClips(doc, buildContext(new Set([frozenTrackStreamKey(0)]))),
    ).toHaveLength(0);
    expect(await buildAudioClips(doc, buildContext(new Set()))).toHaveLength(1);
  });
});

describe('preflightAudioClipMemory with streamed segments', () => {
  const context = (streamedKeys: ReadonlySet<string>) => ({
    tempoMap,
    sampleRate: SAMPLE_RATE,
    checkCancel: () => undefined,
    loadAudioMeta: async (id: string) => meta({ id }),
    streamedKeys,
  });

  it('drops a streamed segment from the prepared and source totals', async () => {
    const doc = docWith([audioClip()]);
    const decoded = await preflightAudioClipMemory(doc, context(new Set()));
    const streamed = await preflightAudioClipMemory(
      doc,
      context(new Set([audioClipSegmentKey(0, 0, 0)])),
    );
    expect(decoded.preparedClipBytes).toBeGreaterThan(0);
    expect(decoded.sourceAudioBytes).toBe(ASSET_FRAMES * 2 * 4);
    expect(streamed.preparedClipBytes).toBe(0);
    expect(streamed.sourceAudioBytes).toBe(0);
    // The render window still has to know the clip is there.
    expect(streamed.audioWindowClips).toEqual(decoded.audioWindowClips);
  });

  it('keeps the source bytes of an asset another segment still decodes', async () => {
    const doc = docWith([audioClip(), audioClip({ startPpq: 64 })]);
    const preflight = await preflightAudioClipMemory(
      doc,
      context(new Set([audioClipSegmentKey(0, 0, 0)])),
    );
    expect(preflight.sourceAudioBytes).toBe(ASSET_FRAMES * 2 * 4);
    expect(preflight.preparedClipBytes).toBeGreaterThan(0);
  });
});

describe('clip stream page sizing', () => {
  it('derives a page from a byte budget', () => {
    expect(clipStreamPageFrames(2, 10_000_000, 2 * 1024 * 1024)).toBe((2 * 1024 * 1024) / 8);
    expect(clipStreamPageFrames(1, 10_000_000, 2 * 1024 * 1024)).toBe((2 * 1024 * 1024) / 4);
  });

  it('never lets the window hold more than decoding the clip would have', () => {
    // A clip barely longer than one page would otherwise keep three pages
    // resident to play a buffer of one.
    const frameCount = 300_000;
    const pageFrames = clipStreamPageFrames(2, frameCount, MAX_CLIP_STREAM_PAGE_BYTES);
    expect(pageFrames * CLIP_STREAM_WINDOW_PAGES).toBeLessThanOrEqual(
      frameCount + CLIP_STREAM_WINDOW_PAGES,
    );
    expect(clipStreamPageFrames(2, 1000, 2 * 1024 * 1024)).toBe(334);
  });

  it('clamps the budget at both ends', () => {
    expect(clipStreamPageFrames(2, 1_000_000, 1)).toBe(MIN_CLIP_STREAM_PAGE_BYTES / 8);
    expect(clipStreamPageFrames(2, 100_000_000, Number.MAX_SAFE_INTEGER)).toBe(
      MAX_CLIP_STREAM_PAGE_BYTES / 8,
    );
  });

  it('shares one resident budget across every streamed clip', () => {
    const budget = 64 * 1024 * 1024;
    expect(clipStreamPageBudgetBytes(1, budget)).toBe(
      Math.floor(budget / CLIP_STREAM_WINDOW_PAGES),
    );
    expect(clipStreamPageBudgetBytes(8, budget)).toBe(
      Math.floor(budget / (8 * CLIP_STREAM_WINDOW_PAGES)),
    );
    expect(clipStreamPageBudgetBytes(0, budget)).toBe(MAX_CLIP_STREAM_PAGE_BYTES);
  });
});

/** Records the page traffic a session produces for one clip. */
function recordingFactory(options: { fail?: (pageIndex: number) => boolean } = {}): {
  factory: ClipPageBindingFactory;
  supplied: number[];
  cleared: number[];
  resident: Set<number>;
  closed: number;
  requests: Array<{ pageFrames: number; numSamples: number; dataOffsetFrames: number }>;
} {
  const supplied: number[] = [];
  const cleared: number[] = [];
  const resident = new Set<number>();
  const requests: Array<{ pageFrames: number; numSamples: number; dataOffsetFrames: number }> = [];
  const state = { closed: 0 };
  const factory: ClipPageBindingFactory = (request): ClipPageBinding => {
    requests.push({
      pageFrames: request.pageFrames,
      numSamples: request.numSamples,
      dataOffsetFrames: request.dataOffsetFrames,
    });
    return {
      provider: { id: request.assetId },
      async supplyPage(pageIndex) {
        if (options.fail?.(pageIndex)) return false;
        supplied.push(pageIndex);
        resident.add(pageIndex);
        return true;
      },
      clearPage(pageIndex) {
        cleared.push(pageIndex);
        resident.delete(pageIndex);
      },
      close() {
        state.closed += 1;
      },
    };
  };
  return {
    factory,
    supplied,
    cleared,
    resident,
    requests,
    get closed() {
      return state.closed;
    },
  };
}

const PAGE_PLAN = {
  key: 'k',
  trackId: 7,
  assetId: 'asset-1',
  startPpq: 4,
  gain: 0.8,
  numChannels: 2,
  sourceStartFrame: 1234,
  frameCount: 100_000,
  timelineStartFrame: 96_000,
};

describe('AudioClipStreamSession', () => {
  it('schedules the clip from its provider at its planned position', async () => {
    const recorder = recordingFactory();
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory);
    expect(session.clipSpecs()).toEqual([
      {
        trackId: 7,
        pageProvider: { id: 'asset-1' },
        startPpq: 4,
        lengthSamples: 100_000,
        gain: 0.8,
      },
    ]);
    // Pages are counted from the clip's own window, not the asset's start.
    expect(recorder.requests[0].dataOffsetFrames).toBe(1234);
    expect(recorder.requests[0].numSamples).toBe(100_000);
    session.close();
    expect(recorder.closed).toBe(1);
  });

  it('slides a bounded window along the render position', async () => {
    const recorder = recordingFactory();
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory, {
      // Forces several pages over the 100k-frame clip.
      residentBudgetBytes: MIN_CLIP_STREAM_PAGE_BYTES * CLIP_STREAM_WINDOW_PAGES,
    });
    const pageFrames = recorder.requests[0].pageFrames;
    expect(pageFrames).toBe(MIN_CLIP_STREAM_PAGE_BYTES / 8);
    const lastPage = Math.ceil(100_000 / pageFrames) - 1;

    await session.advance(PAGE_PLAN.timelineStartFrame, 1024);
    expect([...recorder.resident].sort((a, b) => a - b)).toEqual([0, 1]);

    for (let page = 0; page <= lastPage; page += 1) {
      await session.advance(PAGE_PLAN.timelineStartFrame + page * pageFrames, 1024);
      expect(recorder.resident.size).toBeLessThanOrEqual(CLIP_STREAM_WINDOW_PAGES);
    }
    expect(recorder.supplied).toEqual([...Array(lastPage + 1).keys()]);
    // Everything drains once the render passes the clip's end.
    await session.advance(PAGE_PLAN.timelineStartFrame + 200_000, 1024);
    expect([...recorder.resident]).toEqual([]);
    session.close();
  });

  it('holds the opening pages before the clip starts', async () => {
    const recorder = recordingFactory();
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory);
    await session.advance(0, 1024);
    expect([...recorder.resident].sort((a, b) => a - b)).toEqual([0, 1]);
    session.close();
  });

  it('covers a block that straddles a page boundary', async () => {
    const recorder = recordingFactory();
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory, {
      residentBudgetBytes: MIN_CLIP_STREAM_PAGE_BYTES * CLIP_STREAM_WINDOW_PAGES,
    });
    const pageFrames = recorder.requests[0].pageFrames;
    await session.advance(PAGE_PLAN.timelineStartFrame + pageFrames - 1, 1024);
    expect(recorder.resident.has(1)).toBe(true);
    session.close();
  });

  it('fails the render rather than playing a page it could not read', async () => {
    const recorder = recordingFactory({ fail: (pageIndex) => pageIndex === 1 });
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory, {
      residentBudgetBytes: MIN_CLIP_STREAM_PAGE_BYTES * CLIP_STREAM_WINDOW_PAGES,
    });
    await expect(session.advance(PAGE_PLAN.timelineStartFrame, 1024)).rejects.toBeInstanceOf(
      ClipPageReadError,
    );
    session.close();
  });

  it('closes every provider when one cannot be created', async () => {
    let created = 0;
    const closed: number[] = [];
    const factory: ClipPageBindingFactory = () => {
      created += 1;
      if (created === 2) throw new Error('no provider');
      const index = created;
      return {
        provider: {},
        supplyPage: async () => true,
        close: () => closed.push(index),
      };
    };
    await expect(AudioClipStreamSession.open([PAGE_PLAN, PAGE_PLAN], factory)).rejects.toThrow(
      'no provider',
    );
    expect(closed).toEqual([1]);
  });

  it('reports the resident bytes its window can reach', async () => {
    const recorder = recordingFactory();
    const session = await AudioClipStreamSession.open([PAGE_PLAN], recorder.factory, {
      residentBudgetBytes: MIN_CLIP_STREAM_PAGE_BYTES * CLIP_STREAM_WINDOW_PAGES,
    });
    expect(session.residentBytesUpperBound()).toBe(
      MIN_CLIP_STREAM_PAGE_BYTES * CLIP_STREAM_WINDOW_PAGES,
    );
    session.close();
  });
});

describe('createAssetClipPageBindingFactory', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: coreWasmBinary() });
  });
  beforeEach(resetRecordedClipPageProviders);

  const providers = recordedClipPageProviders;

  const request = {
    assetId: 'asset-1',
    numChannels: 2,
    numSamples: 2500,
    pageFrames: 1000,
    dataOffsetFrames: 40,
  };

  it('reads each page at its offset into the asset, with a short last page', async () => {
    const reads: Array<[string, number, number, number]> = [];
    const readFrames = async (
      assetId: string,
      startFrame: number,
      frameCount: number,
      numChannels: number,
    ) => {
      reads.push([assetId, startFrame, frameCount, numChannels]);
      return [new Float32Array(frameCount), new Float32Array(frameCount)];
    };
    const binding = await createAssetClipPageBindingFactory(readFrames)(request);
    expect(await binding.supplyPage(0)).toBe(true);
    expect(await binding.supplyPage(2)).toBe(true);
    expect(reads).toEqual([
      ['asset-1', 40, 1000, 2],
      ['asset-1', 2040, 500, 2],
    ]);
    expect(providers[0].supplied).toEqual([0, 2]);
    binding.close();
    expect(providers[0].destroyed).toBe(true);
  });

  it('refuses a page outside the clip', async () => {
    const readFrames = vi.fn();
    const binding = await createAssetClipPageBindingFactory(readFrames)(request);
    expect(await binding.supplyPage(-1)).toBe(false);
    expect(await binding.supplyPage(3)).toBe(false);
    expect(readFrames).not.toHaveBeenCalled();
  });

  it('serializes reads so one page is in flight at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const readFrames = async (_id: string, _start: number, frameCount: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [new Float32Array(frameCount), new Float32Array(frameCount)];
    };
    const binding = await createAssetClipPageBindingFactory(readFrames)(request);
    await Promise.all([binding.supplyPage(0), binding.supplyPage(1), binding.supplyPage(2)]);
    expect(peak).toBe(1);
    binding.close();
  });

  it('keeps reading later pages after one read fails, and reports the failure', async () => {
    const readFrames = async (_id: string, startFrame: number, frameCount: number) => {
      if (startFrame === 1040) throw new Error('short read');
      return [new Float32Array(frameCount), new Float32Array(frameCount)];
    };
    const binding = await createAssetClipPageBindingFactory(readFrames)(request);
    await expect(binding.supplyPage(1)).rejects.toThrow('short read');
    expect(await binding.supplyPage(2)).toBe(true);
    expect(providers[0].supplied).toEqual([2]);
    binding.close();
  });

  it('does not write into a provider destroyed while a read was in flight', async () => {
    let release: (() => void) | undefined;
    const readFrames = async (_id: string, _start: number, frameCount: number) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [new Float32Array(frameCount), new Float32Array(frameCount)];
    };
    const binding = await createAssetClipPageBindingFactory(readFrames)(request);
    const pending = binding.supplyPage(0);
    binding.close();
    release?.();
    expect(await pending).toBe(false);
    expect(providers[0].supplied).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { OfflineRenderEngine } from '@/export/engine-render';
import {
  type MasteringCapabilityLookup,
  type MasteringCatalogEntry,
  masteringCapabilityFromCatalog,
  planMasteringStages,
  runMasteringEnginePass,
} from '@/export/mastering-automation';
import { masteringAutomationParam } from '@/project/automation';
import type { InsertSlot, MasteringChainState } from '@/project/mixer';

/**
 * Catalog metadata mirroring what the shipped engine reports for these
 * processors: `eq.tilt` and `dynamics.compressor` are realtime-insertable with
 * automatable parameters, `maximizer.maximizer` exposes a ceiling the engine
 * accepts an automation id for but never moves, and `repair.declick` cannot be
 * an insert at all.
 */
const CATALOG: MasteringCatalogEntry[] = [
  {
    id: 'eq.tilt',
    realtimeInsertable: true,
    latencySamples: 0,
    params: [
      { name: 'tiltDb', rtSafe: true },
      { name: 'pivotHz', rtSafe: true },
    ],
  },
  {
    id: 'dynamics.brickwallLimiter',
    realtimeInsertable: true,
    latencySamples: 48,
    params: [
      { name: 'ceilingDb', rtSafe: true },
      { name: 'releaseMs', rtSafe: true },
    ],
  },
  {
    id: 'eq.linearPhase',
    realtimeInsertable: true,
    latencySamples: 256,
    params: [{ name: 'band0.gainDb', rtSafe: false }],
  },
  {
    id: 'maximizer.maximizer',
    realtimeInsertable: true,
    latencySamples: 0,
    params: [
      { name: 'inputGainDb', rtSafe: true },
      { name: 'ceilingDb', rtSafe: false },
    ],
  },
  {
    id: 'repair.declick',
    realtimeInsertable: false,
    latencySamples: 0,
    params: [{ name: 'sensitivity', rtSafe: true }],
  },
];

const capability = masteringCapabilityFromCatalog(CATALOG);
const noCapability: MasteringCapabilityLookup = () => undefined;

function slot(
  processor: string,
  params: Record<string, number | boolean>,
  id?: string,
): InsertSlot {
  return { processor, params, enabled: true, ...(id === undefined ? {} : { id }) };
}

function chainOf(...processors: InsertSlot[]): MasteringChainState {
  return { processors };
}

function ramp(param: string, from: number, to: number) {
  return {
    param,
    enabled: true,
    points: [
      { ppq: 0, value: from },
      { ppq: 16, value: to },
    ],
  } as const;
}

describe('planMasteringStages', () => {
  it('leaves a rack without automation entirely on the whole-buffer path', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 3 }), slot('repair.declick', {}));

    const plan = planMasteringStages(chain, [], 0, capability);

    expect(plan.frozenParams).toEqual([]);
    expect(plan.stages).toEqual([
      { kind: 'whole-buffer', processorIndex: 0, processor: 'eq.tilt', params: { tiltDb: 3 } },
      { kind: 'whole-buffer', processorIndex: 1, processor: 'repair.declick', params: {} },
    ]);
  });

  it('routes a drivable time-varying parameter through an engine pass', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 0, pivotHz: 900 }));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam(0, 'tiltDb'), 0, 6)],
      0,
      capability,
    );

    expect(plan.frozenParams).toEqual([]);
    expect(plan.stages).toHaveLength(1);
    const stage = plan.stages[0];
    if (stage.kind !== 'engine') throw new Error('expected an engine stage');
    expect(stage.latencySamples).toBe(0);
    expect(stage.slots).toHaveLength(1);
    expect(stage.slots[0].processor).toBe('eq.tilt');
    // The static value stays: the lane overrides it from the seek point on.
    expect(stage.slots[0].params).toEqual({ tiltDb: 0, pivotHz: 900 });
    expect(stage.slots[0].bindings.map((binding) => binding.paramName)).toEqual(['tiltDb']);
  });

  it('freezes a parameter the engine accepts an id for but never moves', () => {
    const chain = chainOf(slot('maximizer.maximizer', { inputGainDb: 0, ceilingDb: -0.3 }));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam(0, 'ceilingDb'), -0.3, -12)],
      0,
      capability,
    );

    expect(plan.frozenParams).toEqual(['maximizer.maximizer.ceilingDb']);
    expect(plan.stages).toEqual([
      {
        kind: 'whole-buffer',
        processorIndex: 0,
        processor: 'maximizer.maximizer',
        params: { inputGainDb: 0, ceilingDb: -0.3 },
      },
    ]);
  });

  it('freezes automation on a processor that cannot be an engine insert', () => {
    const chain = chainOf(slot('repair.declick', { sensitivity: 0.2 }));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam(0, 'sensitivity'), 0.2, 0.8)],
      0,
      capability,
    );

    expect(plan.frozenParams).toEqual(['repair.declick.sensitivity']);
    expect(plan.stages[0]).toMatchObject({ kind: 'whole-buffer', params: { sensitivity: 0.2 } });
  });

  it('renders a constant-valued lane statically without reporting a limitation', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 0 }));

    const plan = planMasteringStages(
      chain,
      [
        {
          param: masteringAutomationParam(0, 'tiltDb'),
          enabled: true,
          points: [
            { ppq: 0, value: 4 },
            { ppq: 16, value: 4 },
          ],
        },
      ],
      0,
      capability,
    );

    expect(plan.frozenParams).toEqual([]);
    expect(plan.stages).toEqual([
      { kind: 'whole-buffer', processorIndex: 0, processor: 'eq.tilt', params: { tiltDb: 4 } },
    ]);
  });

  it('samples a frozen parameter at the window start, not at PPQ 0', () => {
    const chain = chainOf(slot('maximizer.maximizer', { ceilingDb: -0.3 }));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam(0, 'ceilingDb'), -0, -16)],
      8,
      capability,
    );

    expect(plan.stages[0]).toMatchObject({ params: { ceilingDb: -8 } });
  });

  it('keeps declared order and merges only adjacent engine stages', () => {
    const chain = chainOf(
      slot('eq.tilt', { tiltDb: 0 }),
      slot('dynamics.brickwallLimiter', { ceilingDb: -0.3 }),
      slot('repair.declick', {}),
      slot('eq.linearPhase', { 'band0.gainDb': 0 }),
    );

    const plan = planMasteringStages(
      chain,
      [
        ramp(masteringAutomationParam(0, 'tiltDb'), 0, 6),
        ramp(masteringAutomationParam(1, 'ceilingDb'), -0.3, -6),
        ramp(masteringAutomationParam(3, 'band0.gainDb'), 0, 6),
      ],
      0,
      capability,
    );

    expect(plan.stages.map((stage) => stage.kind)).toEqual([
      'engine',
      'whole-buffer',
      'whole-buffer',
    ]);
    const merged = plan.stages[0];
    if (merged.kind !== 'engine') throw new Error('expected an engine stage');
    expect(merged.slots.map((entry) => entry.processor)).toEqual([
      'eq.tilt',
      'dynamics.brickwallLimiter',
    ]);
    // Chained inserts delay by the sum of what they report.
    expect(merged.latencySamples).toBe(48);
    // The non-insertable stage stays between them and the frozen one after it.
    expect(plan.stages[1]).toMatchObject({ processor: 'repair.declick' });
    expect(plan.stages[2]).toMatchObject({ processor: 'eq.linearPhase' });
    expect(plan.frozenParams).toEqual(['eq.linearPhase.band0.gainDb']);
  });

  it('does not split an engine run around a disabled slot', () => {
    const chain = chainOf(
      slot('eq.tilt', { tiltDb: 0 }),
      { processor: 'repair.declick', params: {}, enabled: false },
      slot('dynamics.brickwallLimiter', { ceilingDb: -0.3 }),
    );

    const plan = planMasteringStages(
      chain,
      [
        ramp(masteringAutomationParam(0, 'tiltDb'), 0, 6),
        ramp(masteringAutomationParam(2, 'ceilingDb'), -0.3, -6),
      ],
      0,
      capability,
    );

    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toMatchObject({ kind: 'engine', latencySamples: 48 });
  });

  it('resolves stable processor-id lane tokens as well as positional ones', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 0 }, 'tilt-1'));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam('tilt-1', 'tiltDb'), 0, 6)],
      0,
      capability,
    );

    expect(plan.stages[0]).toMatchObject({ kind: 'engine' });
  });

  it('drives nothing when the build reports no processor catalog', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 0 }));

    const plan = planMasteringStages(
      chain,
      [ramp(masteringAutomationParam(0, 'tiltDb'), 0, 6)],
      0,
      noCapability,
    );

    expect(plan.stages.map((stage) => stage.kind)).toEqual(['whole-buffer']);
    expect(plan.frozenParams).toEqual(['eq.tilt.tiltDb']);
  });

  it('ignores disabled and empty lanes', () => {
    const chain = chainOf(slot('eq.tilt', { tiltDb: 3 }));

    const plan = planMasteringStages(
      chain,
      [
        { ...ramp(masteringAutomationParam(0, 'tiltDb'), 0, 6), enabled: false },
        { param: masteringAutomationParam(0, 'pivotHz'), enabled: true, points: [] },
      ],
      0,
      capability,
    );

    expect(plan.stages).toEqual([
      { kind: 'whole-buffer', processorIndex: 0, processor: 'eq.tilt', params: { tiltDb: 3 } },
    ]);
    expect(plan.frozenParams).toEqual([]);
  });
});

/**
 * Engine double for the mastering pass. It reproduces the two behaviours the
 * shipped engine was measured to have: a strip insert delays its output by the
 * latency the catalog reports for it, and an automation lane drives the
 * parameter from the seek position onward. Rendering is a pure delay plus an
 * optional per-sample gain so a test can assert sample alignment exactly.
 */
class MasteringPassEngine implements Partial<OfflineRenderEngine> {
  calls: Array<[string, ...unknown[]]> = [];
  destroyed = false;
  /** Automation ids this engine refuses to resolve, by parameter name. */
  unresolvable = new Set<string>();

  private clip: { channels: Float32Array[]; startSample: number } | null = null;
  private cursor = 0;
  private playing = false;
  private gainByParamId = new Map<number, Array<{ ppq: number; value: number }>>();

  constructor(private readonly latencySamples = 0) {}

  named(name: string): Array<[string, ...unknown[]]> {
    return this.calls.filter(([called]) => called === name);
  }

  setTrackLanes(lanes: unknown): void {
    this.calls.push(['setTrackLanes', lanes]);
  }
  setStrip(ref: number | 'master', settings: unknown): void {
    this.calls.push(['setStrip', ref, settings]);
  }
  setTempoSegments(segments: unknown): void {
    this.calls.push(['setTempoSegments', segments]);
  }
  setClips(clips: unknown): void {
    this.calls.push(['setClips', clips]);
    const [first] = clips as Array<{ channels: Float32Array[]; startPpq: number }>;
    // The pass places the clip at the window start and seeks there, so within
    // this double the clip simply begins at the seek position.
    this.clip = { channels: first.channels, startSample: 0 };
  }
  resolveStripInsertAutomationId(
    ref: number | 'master',
    insertIndex: number,
    paramName: string,
  ): number {
    this.calls.push(['resolveStripInsertAutomationId', ref, insertIndex, paramName]);
    if (this.unresolvable.has(paramName)) {
      throw new RangeError(`paramName '${paramName}' does not resolve to an automation id`);
    }
    return (0xe000_0000 | (insertIndex << 8)) >>> 0;
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.calls.push(['setAutomationLane', paramId, points]);
    this.gainByParamId.set(paramId, points as Array<{ ppq: number; value: number }>);
  }
  pushMidiUmp(destinationId: number, words: Uint32Array | number[]): void {
    this.calls.push(['pushMidiUmp', destinationId, words]);
  }
  seekSample(sample: number): void {
    this.calls.push(['seekSample', sample]);
    this.cursor = sample;
  }
  settleParameters(): void {
    this.calls.push(['settleParameters']);
  }
  play(): void {
    this.calls.push(['play']);
    this.playing = true;
  }
  stop(): void {
    this.calls.push(['stop']);
    this.playing = false;
  }
  process(channels: Float32Array[]): Float32Array[] {
    const frames = channels[0].length;
    if (!this.playing) {
      for (const channel of channels) channel.fill(0);
      return channels;
    }
    const base = this.cursor;
    for (let frame = 0; frame < frames; frame += 1) {
      const source = base + frame - this.latencySamples;
      for (let channel = 0; channel < channels.length; channel += 1) {
        const clip = this.clip?.channels[channel];
        channels[channel][frame] = source >= 0 && clip ? (clip[source] ?? 0) : 0;
      }
    }
    this.cursor += frames;
    return channels;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const RAMP_STAGE = {
  kind: 'engine',
  latencySamples: 0,
  slots: [
    {
      processorIndex: 0,
      processor: 'eq.tilt',
      params: { tiltDb: 0 },
      bindings: [
        {
          paramName: 'tiltDb',
          points: [
            { ppq: 0, value: 0 },
            { ppq: 16, value: 6 },
          ],
        },
      ],
    },
  ],
} as const;

function ascending(frames: number, offset = 0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = (i + offset) / frames;
  return out;
}

describe('runMasteringEnginePass', () => {
  const context = (engine: MasteringPassEngine) => ({
    createEngine: () => engine as unknown as OfflineRenderEngine,
    sampleRate: 48000,
    startSample: 0,
    startPpq: 0,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
  });

  it('schedules the mix at the window position and drives the bound parameters', async () => {
    const engine = new MasteringPassEngine();
    const left = ascending(2048);
    const right = ascending(2048, 1);

    await runMasteringEnginePass(RAMP_STAGE, left, right, {
      ...context(engine),
      startSample: 96000,
      startPpq: 4,
    });

    expect(engine.named('setClips')).toEqual([
      ['setClips', [{ trackId: 1, channels: [left, right], startPpq: 4, lengthSamples: 2048 }]],
    ]);
    expect(engine.named('seekSample')).toEqual([['seekSample', 96000]]);
    expect(engine.named('resolveStripInsertAutomationId')).toEqual([
      ['resolveStripInsertAutomationId', 1, 0, 'tiltDb'],
    ]);
    expect(engine.named('setAutomationLane')).toEqual([
      [
        'setAutomationLane',
        0xe000_0000,
        [
          { ppq: 0, value: 0, curveToNext: 'linear' },
          { ppq: 16, value: 6, curveToNext: 'linear' },
        ],
      ],
    ]);
    const [[, , scene]] = engine.named('setStrip') as Array<
      [string, number, { inserts: unknown[] }]
    >;
    expect(scene.inserts).toEqual([{ slot: 'pre', processor: 'eq.tilt', params: { tiltDb: 0 } }]);
    expect(engine.destroyed).toBe(true);
  });

  it('removes the insert latency so the stage stays time-aligned', async () => {
    const engine = new MasteringPassEngine(48);
    const left = ascending(4096);
    const right = ascending(4096, 7);

    const out = await runMasteringEnginePass(
      { ...RAMP_STAGE, latencySamples: 48 },
      left,
      right,
      context(engine),
    );

    expect(out.left.length).toBe(4096);
    expect(out.right.length).toBe(4096);
    expect(Array.from(out.left)).toEqual(Array.from(left));
    expect(Array.from(out.right)).toEqual(Array.from(right));
  });

  it('realigns a latency larger than one render block', async () => {
    const engine = new MasteringPassEngine(1536);
    const left = ascending(4096);

    const out = await runMasteringEnginePass(
      { ...RAMP_STAGE, latencySamples: 1536 },
      left,
      left,
      context(engine),
    );

    expect(Array.from(out.left)).toEqual(Array.from(left));
  });

  it('skips a parameter the engine will not resolve an id for', async () => {
    const engine = new MasteringPassEngine();
    engine.unresolvable.add('tiltDb');

    await runMasteringEnginePass(RAMP_STAGE, ascending(1024), ascending(1024), context(engine));

    expect(engine.named('setAutomationLane')).toEqual([]);
  });

  it('destroys the engine when the render is cancelled mid-pass', async () => {
    const engine = new MasteringPassEngine();
    const checkCancel = vi.fn(() => {
      throw new Error('cancelled');
    });

    await expect(
      runMasteringEnginePass(RAMP_STAGE, ascending(4096), ascending(4096), {
        ...context(engine),
        checkCancel,
      }),
    ).rejects.toThrow('cancelled');
    expect(engine.destroyed).toBe(true);
  });
});

describe('runMasteringEnginePass input planes', () => {
  class InputTrackingEngine extends MasteringPassEngine {
    readonly inputs = new Set<Float32Array>();
    processCalls = 0;
    dirtyInputs = 0;
    process(channels: Float32Array[]): Float32Array[] {
      this.processCalls += 1;
      for (const channel of channels) {
        this.inputs.add(channel);
        if (channel.some((sample) => sample !== 0)) this.dirtyInputs += 1;
      }
      return super.process(channels);
    }
  }

  it('reuses zeroed silent input planes across blocks', async () => {
    const engine = new InputTrackingEngine();
    const frames = 10 * 1024 + 300;
    await runMasteringEnginePass(RAMP_STAGE, ascending(frames), ascending(frames, 1), {
      createEngine: () => engine as unknown as OfflineRenderEngine,
      sampleRate: 48000,
      startSample: 0,
      startPpq: 0,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
    });

    expect(engine.processCalls).toBe(12);
    expect(engine.dirtyInputs).toBe(0);
    expect(engine.inputs.size).toBeLessThanOrEqual(4);
  });
});

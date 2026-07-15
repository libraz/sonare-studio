import { describe, expect, it, vi } from 'vitest';
import { createAutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import {
  type AutomationLaneState,
  type AutomationPoint,
  type AutomationTarget,
  busAutomationTarget,
  insertAutomationParam,
  masteringAutomationParam,
} from '@/project/automation';

/** Param ids the stub hands out: track ids map to 1000 + id (faderDb) / 2000 + id (pan). */
function stubParamId(target: string | number, kind: 'faderDb' | 'pan'): number {
  const base = kind === 'faderDb' ? 1000 : 2000;
  return target === 'master' ? base : base + Number(target);
}

/** EngineHandle stub capturing the automation commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    automationParamId: ReturnType<typeof vi.fn>;
    busAutomationParamId: ReturnType<typeof vi.fn>;
    setAutomationLane: ReturnType<typeof vi.fn>;
    resolveTrackInsertAutomationId: ReturnType<typeof vi.fn>;
    resolveMasterInsertAutomationId: ReturnType<typeof vi.fn>;
    resolveBusInsertAutomationId: ReturnType<typeof vi.fn>;
  };
} {
  // Insert resolvers hand out a deterministic id; an 'unknown' param name
  // models a strip/insert/key the engine cannot resolve (returns -1).
  const engine = {
    automationParamId: vi.fn(stubParamId),
    busAutomationParamId: vi.fn((busId: number) => 3000 + busId),
    setAutomationLane: vi.fn(),
    resolveTrackInsertAutomationId: vi.fn((trackId: number, _insert: number, name: string) =>
      name === 'unknown' ? -1 : 5000 + Number(trackId),
    ),
    resolveMasterInsertAutomationId: vi.fn((_insert: number, name: string) =>
      name === 'unknown' ? -1 : 6000,
    ),
    resolveBusInsertAutomationId: vi.fn((busId: number, _insert: number, name: string) =>
      name === 'unknown' ? -1 : 7000 + busId,
    ),
  };
  const handle = { engine } as unknown as EngineHandle;
  return { handle, engine };
}

/** Builds a lane with overridable fields. */
function makeLane(
  target: AutomationTarget,
  points: AutomationPoint[],
  overrides: Partial<AutomationLaneState> = {},
): AutomationLaneState {
  return { target, param: 'faderDb', points, enabled: true, ...overrides };
}

describe('createAutomationSync', () => {
  it('installs a bus fader lane through the bus automation parameter id', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [],
      busIdFor: (busId) => (busId === 'fx' ? 2 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([makeLane(busAutomationTarget('fx'), [{ ppq: 0, value: -9 }])]);

    expect(engine.busAutomationParamId).toHaveBeenCalledWith(2);
    expect(engine.automationParamId).not.toHaveBeenCalled();
    expect(engine.setAutomationLane).toHaveBeenCalledWith(3002, [
      { ppq: 0, value: -9, curveToNext: 0 },
    ]);
  });

  it('maps group-track fader automation to the group bus parameter id', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [10],
      groupBusIdFor: (trackId) => (trackId === 10 ? 4 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([makeLane(10, [{ ppq: 0, value: -7 }])]);

    expect(engine.busAutomationParamId).toHaveBeenCalledWith(4);
    expect(engine.automationParamId).not.toHaveBeenCalled();
    expect(engine.setAutomationLane).toHaveBeenCalledWith(3004, [
      { ppq: 0, value: -7, curveToNext: 0 },
    ]);
  });

  it('maps group-track insert automation to the group bus insert resolver', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [10],
      groupBusIdFor: (trackId) => (trackId === 10 ? 4 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(10, [{ ppq: 0, value: 0.5 }], {
        param: insertAutomationParam(1, 'drive'),
      }),
    ]);

    expect(engine.resolveBusInsertAutomationId).toHaveBeenCalledWith(4, 1, 'drive');
    expect(engine.resolveTrackInsertAutomationId).not.toHaveBeenCalled();
    expect(engine.setAutomationLane).toHaveBeenCalledWith(7004, [
      { ppq: 0, value: 0.5, curveToNext: 0 },
    ]);
  });

  it('uses enabled-only insert indexes for bus insert automation when provided', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [],
      busIdFor: (busId) => (busId === 'fx' ? 2 : undefined),
      busInsertIndexFor: (busId, index) => (busId === 'fx' && index === 2 ? 1 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(busAutomationTarget('fx'), [{ ppq: 0, value: 0.5 }], {
        param: insertAutomationParam(2, 'drive'),
      }),
      makeLane(busAutomationTarget('fx'), [{ ppq: 0, value: 0.25 }], {
        param: insertAutomationParam(0, 'drive'),
      }),
    ]);

    expect(engine.resolveBusInsertAutomationId).toHaveBeenCalledTimes(1);
    expect(engine.resolveBusInsertAutomationId).toHaveBeenCalledWith(2, 1, 'drive');
  });

  it('maps mastering-chain automation through the live master strip insert resolver', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [],
      masteringInsertIndexFor: (processorIndex) => (processorIndex === 2 ? 4 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane('master', [{ ppq: 0, value: -1 }], {
        param: masteringAutomationParam(2, 'ceilingDb'),
      }),
      makeLane('master', [{ ppq: 0, value: 0.5 }], {
        param: masteringAutomationParam(3, 'drive'),
      }),
      makeLane(1, [{ ppq: 0, value: 0.5 }], {
        param: masteringAutomationParam(2, 'ceilingDb'),
      }),
    ]);

    expect(engine.resolveMasterInsertAutomationId).toHaveBeenCalledTimes(1);
    expect(engine.resolveMasterInsertAutomationId).toHaveBeenCalledWith(4, 'ceilingDb');
    expect(engine.setAutomationLane).toHaveBeenCalledWith(6000, [
      { ppq: 0, value: -1, curveToNext: 0 },
    ]);
    expect(sync.installedParamIds()).toStrictEqual([6000]);
  });

  it('resolves stable processor identities after insert and mastering reorders', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      insertStoreIndexFor: (target, processorId) =>
        target === 1 && processorId === 'track-compressor' ? 2 : undefined,
      masteringProcessorIndexFor: (processorId) =>
        processorId === 'master-limiter' ? 1 : undefined,
      masteringInsertIndexFor: (processorIndex) => (processorIndex === 1 ? 4 : undefined),
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(1, [{ ppq: 0, value: -18 }], {
        param: insertAutomationParam('track-compressor', 'thresholdDb'),
      }),
      makeLane('master', [{ ppq: 0, value: -1 }], {
        param: masteringAutomationParam('master-limiter', 'ceilingDb'),
      }),
    ]);

    expect(engine.resolveTrackInsertAutomationId).toHaveBeenCalledWith(1, 2, 'thresholdDb');
    expect(engine.resolveMasterInsertAutomationId).toHaveBeenCalledWith(4, 'ceilingDb');
  });

  it('installs an effective lane with curve codes on its points', () => {
    const { handle, engine } = makeHandle();
    const restoreParam = vi.fn();
    const sync = createAutomationSync(handle, { knownTrackIds: () => [1], restoreParam });

    sync.sync([
      makeLane(1, [
        { ppq: 0, value: -60 },
        { ppq: 4, value: 0, curve: 'hold' },
      ]),
    ]);
    expect(engine.automationParamId).toHaveBeenCalledWith(1, 'faderDb');
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId(1, 'faderDb'), [
      { ppq: 0, value: -60, curveToNext: 0 },
      { ppq: 4, value: 0, curveToNext: 2 },
    ]);
    expect(sync.installedParamIds()).toStrictEqual([stubParamId(1, 'faderDb')]);
    expect(restoreParam).not.toHaveBeenCalled();
  });

  it('adds the current VCA offset to track fader automation values', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
      vcaOffsetFor: (trackId) => (trackId === 1 ? -6 : 0),
    });

    sync.sync([makeLane(1, [{ ppq: 0, value: -12 }])]);

    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId(1, 'faderDb'), [
      { ppq: 0, value: -18, curveToNext: 0 },
    ]);
  });

  it('pins group fader automation to silence across track and VCA mute changes', () => {
    const { handle, engine } = makeHandle();
    let muted = false;
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [10],
      groupBusIdFor: (trackId) => (trackId === 10 ? 4 : undefined),
      vcaOffsetFor: () => -6,
      effectiveMuteFor: () => muted,
      restoreParam: vi.fn(),
    });
    const lanes = [
      makeLane(10, [
        { ppq: 0, value: -12 },
        { ppq: 4, value: 0, curve: 'hold' },
      ]),
    ];

    sync.sync(lanes);
    expect(engine.setAutomationLane).toHaveBeenLastCalledWith(3004, [
      { ppq: 0, value: -18, curveToNext: 0 },
      { ppq: 4, value: -6, curveToNext: 2 },
    ]);

    muted = true;
    sync.sync(lanes);
    expect(engine.setAutomationLane).toHaveBeenLastCalledWith(3004, [
      { ppq: 0, value: -120, curveToNext: 0 },
      { ppq: 4, value: -120, curveToNext: 2 },
    ]);

    muted = false;
    sync.sync(lanes);
    expect(engine.setAutomationLane).toHaveBeenLastCalledWith(3004, [
      { ppq: 0, value: -18, curveToNext: 0 },
      { ppq: 4, value: -6, curveToNext: 2 },
    ]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(3);
  });

  it('sends nothing on an identical second sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
    });
    const lanes = [makeLane(1, [{ ppq: 0, value: -6 }])];

    sync.sync(lanes);
    engine.setAutomationLane.mockClear();

    sync.sync(lanes);
    expect(engine.setAutomationLane).not.toHaveBeenCalled();
  });

  it('re-sends the lane when its points change', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
    });

    sync.sync([makeLane(1, [{ ppq: 0, value: -6 }])]);
    engine.setAutomationLane.mockClear();

    sync.sync([makeLane(1, [{ ppq: 0, value: -12 }])]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId(1, 'faderDb'), [
      { ppq: 0, value: -12, curveToNext: 0 },
    ]);
  });

  it('clears the engine lane and restores the manual value on lane removal', () => {
    const { handle, engine } = makeHandle();
    const restoreParam = vi.fn();
    const sync = createAutomationSync(handle, { knownTrackIds: () => [1], restoreParam });

    sync.sync([makeLane(1, [{ ppq: 0, value: -6 }], { param: 'pan' })]);
    engine.setAutomationLane.mockClear();

    sync.sync([]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId(1, 'pan'), []);
    expect(restoreParam).toHaveBeenCalledTimes(1);
    expect(restoreParam).toHaveBeenCalledWith(1, 'pan');
    expect(sync.installedParamIds()).toStrictEqual([]);
  });

  it('clears the engine lane and restores the manual value when a lane is disabled', () => {
    const { handle, engine } = makeHandle();
    const restoreParam = vi.fn();
    const sync = createAutomationSync(handle, { knownTrackIds: () => [], restoreParam });
    const points: AutomationPoint[] = [{ ppq: 0, value: -6 }];

    sync.sync([makeLane('master', points)]);
    engine.setAutomationLane.mockClear();

    sync.sync([makeLane('master', points, { enabled: false })]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId('master', 'faderDb'), []);
    expect(restoreParam).toHaveBeenCalledWith('master', 'faderDb');
    expect(sync.installedParamIds()).toStrictEqual([]);
  });

  it('skips lanes targeting tracks the mixer sync has not declared', () => {
    const { handle, engine } = makeHandle();
    const knownTrackIds = vi.fn<() => readonly number[]>(() => []);
    const sync = createAutomationSync(handle, { knownTrackIds, restoreParam: vi.fn() });

    sync.sync([makeLane(7, [{ ppq: 0, value: -6 }])]);
    expect(engine.automationParamId).not.toHaveBeenCalled();
    expect(engine.setAutomationLane).not.toHaveBeenCalled();
    expect(sync.installedParamIds()).toStrictEqual([]);

    // Once the track is declared, the same lane installs.
    knownTrackIds.mockReturnValue([7]);
    sync.sync([makeLane(7, [{ ppq: 0, value: -6 }])]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(sync.installedParamIds()).toStrictEqual([stubParamId(7, 'faderDb')]);
  });

  it('installs an insert-parameter lane via the engine-resolved insert id', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(1, [{ ppq: 0, value: 0.5 }], {
        param: insertAutomationParam(0, 'drive'),
      }),
    ]);

    // The insert lane resolves through the insert id, never the fader/pan path.
    expect(engine.resolveTrackInsertAutomationId).toHaveBeenCalledWith(1, 0, 'drive');
    expect(engine.automationParamId).not.toHaveBeenCalled();
    expect(engine.setAutomationLane).toHaveBeenCalledWith(5001, [
      { ppq: 0, value: 0.5, curveToNext: 0 },
    ]);
    expect(sync.installedParamIds()).toStrictEqual([5001]);
  });

  it('skips an insert lane the engine cannot resolve (negative id)', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(1, [{ ppq: 0, value: 0.5 }], {
        param: insertAutomationParam(9, 'unknown'),
      }),
    ]);

    expect(engine.resolveTrackInsertAutomationId).toHaveBeenCalledWith(1, 9, 'unknown');
    expect(engine.setAutomationLane).not.toHaveBeenCalled();
    expect(sync.installedParamIds()).toStrictEqual([]);
  });

  it('drops non-finite points and skips lanes left without any', () => {
    const { handle, engine } = makeHandle();
    const sync = createAutomationSync(handle, {
      knownTrackIds: () => [1],
      restoreParam: vi.fn(),
    });

    sync.sync([
      makeLane(1, [
        { ppq: Number.NaN, value: -6 },
        { ppq: 0, value: -12 },
        { ppq: 4, value: Number.POSITIVE_INFINITY },
      ]),
      makeLane('master', [{ ppq: Number.NaN, value: Number.NaN }]),
    ]);
    expect(engine.setAutomationLane).toHaveBeenCalledTimes(1);
    expect(engine.setAutomationLane).toHaveBeenCalledWith(stubParamId(1, 'faderDb'), [
      { ppq: 0, value: -12, curveToNext: 0 },
    ]);
    expect(sync.installedParamIds()).toStrictEqual([stubParamId(1, 'faderDb')]);
  });
});

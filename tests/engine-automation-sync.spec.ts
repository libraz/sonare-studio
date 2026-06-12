import { describe, expect, it, vi } from 'vitest';
import { createAutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import type { AutomationLaneState, AutomationPoint } from '@/project/automation';

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
    setAutomationLane: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    automationParamId: vi.fn(stubParamId),
    setAutomationLane: vi.fn(),
  };
  const handle = { engine } as unknown as EngineHandle;
  return { handle, engine };
}

/** Builds a lane with overridable fields. */
function makeLane(
  target: number | 'master',
  points: AutomationPoint[],
  overrides: Partial<AutomationLaneState> = {},
): AutomationLaneState {
  return { target, param: 'faderDb', points, enabled: true, ...overrides };
}

describe('createAutomationSync', () => {
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

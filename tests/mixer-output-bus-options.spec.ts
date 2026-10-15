import { describe, expect, it, vi } from 'vitest';
import * as topology from '@/project/bus-topology';
import { createDefaultStrip, type ProjectMixerState } from '@/project/mixer';
import { buildOutputBusOptions, createOutputBusGuard } from '@/ui/mixer/output-bus-options';

function mixerWith(routes: Record<string, string | undefined>): ProjectMixerState {
  const buses = Object.entries(routes).map(([id, outputBusId]) => ({
    id,
    name: id.toUpperCase(),
    strip: { ...createDefaultStrip(), ...(outputBusId ? { outputBusId } : {}) },
  }));
  return { buses } as unknown as ProjectMixerState;
}

describe('createOutputBusGuard', () => {
  it('allows everything for a strip without a bus node', () => {
    const guard = createOutputBusGuard(mixerWith({ a: undefined }), [], undefined);
    expect(guard('a')).toBe(true);
  });

  it('rejects self-routes and cycles', () => {
    const guard = createOutputBusGuard(mixerWith({ a: undefined, b: 'a' }), [], 'a');
    expect(guard('a')).toBe(false);
    expect(guard('b')).toBe(false);
  });

  it('builds the topology once for any number of lookups', () => {
    const spy = vi.spyOn(topology, 'mixerBusTopology');
    const guard = createOutputBusGuard(mixerWith({ a: undefined, b: undefined, c: 'a' }), [], 'a');
    guard('b');
    guard('c');
    guard('b');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('buildOutputBusOptions', () => {
  it('lists master first and disables loop-forming buses with the reason', () => {
    const options = buildOutputBusOptions(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      (id) => id === 'a',
      { master: 'Master', busLoop: 'Loop' },
    );
    expect(options).toEqual([
      { value: '', label: 'Master' },
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true, detail: 'Loop' },
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import {
  addInsertSlot,
  adjustExpandedAfterRemove,
  type InsertRackCommands,
  removeInsertSlot,
  toggleInsertEnabled,
} from '@/ui/mixer/insert-rack';

/** Builds a fully mocked command layer for rack assertions. */
function mockCommands(addReturn = 0): InsertRackCommands {
  return {
    addInsert: vi.fn(() => addReturn),
    removeInsert: vi.fn(),
    setInsertEnabled: vi.fn(),
  };
}

function slot(enabled: boolean): InsertSlot {
  return { processor: 'dynamics.compressor', params: {}, enabled };
}

describe('addInsertSlot', () => {
  it('adds the processor and returns the new slot index', () => {
    const commands = mockCommands(2);
    expect(addInsertSlot(5, 'saturation.tape', commands)).toBe(2);
    expect(commands.addInsert).toHaveBeenCalledWith(5, 'saturation.tape');
  });

  it('targets the master strip', () => {
    const commands = mockCommands();
    addInsertSlot('master', 'eq.parametric', commands);
    expect(commands.addInsert).toHaveBeenCalledWith('master', 'eq.parametric');
  });
});

describe('removeInsertSlot', () => {
  it('removes by target and index', () => {
    const commands = mockCommands();
    removeInsertSlot(7, 1, commands);
    expect(commands.removeInsert).toHaveBeenCalledWith(7, 1);
  });
});

describe('toggleInsertEnabled', () => {
  it('bypasses an enabled slot', () => {
    const commands = mockCommands();
    toggleInsertEnabled('master', 0, slot(true), commands);
    expect(commands.setInsertEnabled).toHaveBeenCalledWith('master', 0, false);
  });

  it('re-enables a bypassed slot', () => {
    const commands = mockCommands();
    toggleInsertEnabled(3, 2, slot(false), commands);
    expect(commands.setInsertEnabled).toHaveBeenCalledWith(3, 2, true);
  });
});

describe('adjustExpandedAfterRemove', () => {
  it('keeps null collapsed', () => {
    expect(adjustExpandedAfterRemove(null, 0)).toBeNull();
  });

  it('collapses when the expanded slot was removed', () => {
    expect(adjustExpandedAfterRemove(1, 1)).toBeNull();
  });

  it('shifts down when an earlier slot was removed', () => {
    expect(adjustExpandedAfterRemove(2, 0)).toBe(1);
  });

  it('keeps the index when a later slot was removed', () => {
    expect(adjustExpandedAfterRemove(1, 3)).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import {
  applyChainReorder,
  type ChainReorderOps,
  type ChainReorderStep,
  moveIndex,
  planChainReorder,
} from '@/ui/mastering/chain-reorder';

function slot(processor: string, enabled = true, params: InsertSlot['params'] = {}): InsertSlot {
  return { processor, params, enabled };
}

/** Simulates the mastering command layer over a plain array. */
function makeArrayOps(slots: InsertSlot[]): ChainReorderOps & { slots: InsertSlot[] } {
  return {
    slots,
    remove(index) {
      slots.splice(index, 1);
    },
    append(processor, params) {
      slots.push({ processor, params: { ...params }, enabled: true });
    },
    setEnabled(index, enabled) {
      slots[index] = { ...slots[index], enabled };
    },
  };
}

describe('moveIndex', () => {
  it('moves an item forward and backward', () => {
    expect(moveIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveIndex(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns an unchanged copy for equal or out-of-range indices', () => {
    const list = ['a', 'b', 'c'];
    expect(moveIndex(list, 1, 1)).toEqual(list);
    expect(moveIndex(list, -1, 2)).toEqual(list);
    expect(moveIndex(list, 0, 3)).toEqual(list);
    expect(moveIndex(list, 0.5, 2)).toEqual(list);
    expect(moveIndex(list, 0, 2)).not.toBe(list);
  });
});

describe('planChainReorder', () => {
  it('returns an empty plan for no-op or invalid moves', () => {
    const slots = [slot('eq.tilt'), slot('dynamics.compressor')];
    expect(planChainReorder(slots, 1, 1)).toEqual([]);
    expect(planChainReorder(slots, -1, 0)).toEqual([]);
    expect(planChainReorder(slots, 0, 2)).toEqual([]);
    expect(planChainReorder([], 0, 0)).toEqual([]);
  });

  it('rebuilds only the suffix from the lower index', () => {
    const slots = [slot('a.one'), slot('b.two'), slot('c.three'), slot('d.four')];
    const steps = planChainReorder(slots, 1, 3);
    // Removals come first, from the end down to index 1; index 0 untouched.
    expect(steps.slice(0, 3)).toEqual([
      { type: 'remove', index: 3 },
      { type: 'remove', index: 2 },
      { type: 'remove', index: 1 },
    ]);
    const appends = steps.filter(
      (step): step is Extract<ChainReorderStep, { type: 'append' }> => step.type === 'append',
    );
    expect(appends.map((step) => step.processor)).toEqual(['c.three', 'd.four', 'b.two']);
  });

  it('copies params into the plan', () => {
    const slots = [slot('a.one', true, { driveDb: 3 }), slot('b.two')];
    const steps = planChainReorder(slots, 0, 1);
    const appended = steps.find((step) => step.type === 'append' && step.processor === 'a.one');
    expect(appended).toMatchObject({ params: { driveDb: 3 } });
    // The plan owns its copies: mutating it must not touch the source slot.
    if (appended?.type === 'append') appended.params.driveDb = 9;
    expect(slots[0].params.driveDb).toBe(3);
  });

  it('restores bypassed slots after re-appending', () => {
    const slots = [slot('a.one', false), slot('b.two')];
    const steps = planChainReorder(slots, 0, 1);
    expect(steps[steps.length - 1]).toEqual({ type: 'enable', index: 1, enabled: false });
  });
});

describe('applyChainReorder', () => {
  it.each([
    [0, 2],
    [2, 0],
    [1, 3],
    [3, 1],
    [0, 3],
  ])('produces the moveIndex order for %i -> %i with enabled states intact', (from, to) => {
    const source = [
      slot('a.one', true, { x: 1 }),
      slot('b.two', false),
      slot('c.three', true),
      slot('d.four', false, { y: 2 }),
    ];
    const ops = makeArrayOps(source.map((entry) => ({ ...entry, params: { ...entry.params } })));
    applyChainReorder(planChainReorder(ops.slots, from, to), ops);
    expect(ops.slots).toEqual(moveIndex(source, from, to));
  });

  it('does nothing for an empty plan', () => {
    const ops = makeArrayOps([slot('a.one')]);
    applyChainReorder([], ops);
    expect(ops.slots).toEqual([slot('a.one')]);
  });
});

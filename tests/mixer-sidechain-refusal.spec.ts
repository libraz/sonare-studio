import type { SidechainCheck, SidechainRefusal } from '@libraz/libsonare';
import { describe, expect, it, vi } from 'vitest';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import {
  createSidechainRefusalLookup,
  type SidechainCheckEngine,
} from '@/ui/mixer/sidechain-refusal';

const ALL_REFUSALS: SidechainRefusal[] = [
  'invalidTarget',
  'insertOutOfRange',
  'undeclaredSource',
  'invalidSourceKind',
  'selfKey',
  'cycle',
  'tableFull',
  'planRefused',
];

function check(reason: SidechainRefusal | null): SidechainCheck {
  return reason === null ? { ok: true } : { ok: false, reason };
}

function setup(reason: SidechainRefusal | null = 'planRefused') {
  const engine = {
    canSetStripSidechain: vi.fn(() => check(reason)),
    canSetBusSidechain: vi.fn(() => check(reason)),
  } satisfies SidechainCheckEngine;
  const ids = {
    busIdFor: vi.fn((id: string) => ({ fx: 2, 'group:7': 5 })[id]),
    groupBusIdFor: vi.fn((trackId: number) => (trackId === 7 ? 5 : undefined)),
    busInsertIndexFor: vi.fn((_id: string, index: number) => index),
    groupInsertIndexFor: vi.fn((_trackId: number, index: number) => index),
  };
  const tracks = [
    { id: 1, kind: 'audio' as const },
    { id: 2, kind: 'audio' as const },
    { id: 7, kind: 'group' as const },
  ];
  const lookup = createSidechainRefusalLookup(engine, ids, () => tracks);
  return { engine, lookup };
}

describe('createSidechainRefusalLookup', () => {
  it('asks the strip query for an ordinary track with the store insert index', () => {
    const { engine, lookup } = setup();
    expect(lookup(1, 2, { kind: 'track', trackId: 2 })).toBe('planRefused');
    expect(engine.canSetStripSidechain).toHaveBeenCalledWith(1, 2, { kind: 'track', id: 2 });
  });

  it('returns null when the engine accepts', () => {
    const { lookup } = setup(null);
    expect(lookup(1, 0, { kind: 'track', trackId: 2 })).toBeNull();
  });

  it('routes group tracks and return buses through the bus query with engine ids', () => {
    const { engine, lookup } = setup('cycle');
    expect(lookup(7, 1, { kind: 'track', trackId: 1 })).toBe('cycle');
    expect(engine.canSetBusSidechain).toHaveBeenLastCalledWith(5, 1, { kind: 'track', id: 1 });
    expect(lookup('bus:fx', 0, { kind: 'group', trackId: 7 })).toBe('cycle');
    expect(engine.canSetBusSidechain).toHaveBeenLastCalledWith(2, 0, { kind: 'bus', id: 5 });
  });

  it('routes the master through the strip query', () => {
    const { engine, lookup } = setup('selfKey');
    expect(lookup('master', 3, { kind: 'bus', busId: 'fx' })).toBe('selfKey');
    expect(engine.canSetStripSidechain).toHaveBeenCalledWith('master', 3, { kind: 'bus', id: 2 });
  });

  it('has no opinion while a bus is not mapped to the engine yet', () => {
    const { engine, lookup } = setup();
    expect(lookup('master', 0, { kind: 'bus', busId: 'missing' })).toBeNull();
    expect(lookup('bus:missing', 0, { kind: 'track', trackId: 1 })).toBeNull();
    expect(engine.canSetStripSidechain).not.toHaveBeenCalled();
    expect(engine.canSetBusSidechain).not.toHaveBeenCalled();
  });
});

describe('sidechain refusal strings', () => {
  it('localizes every refusal code in both languages', () => {
    for (const reason of ALL_REFUSALS) {
      expect(en.shell.inserts.sidechainRefusal[reason]).toMatch(/\S/);
      expect(ja.shell.inserts.sidechainRefusal[reason]).toMatch(/\S/);
    }
    expect(Object.keys(en.shell.inserts.sidechainRefusal).sort()).toEqual([...ALL_REFUSALS].sort());
  });
});

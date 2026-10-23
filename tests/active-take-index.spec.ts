import { describe, expect, it } from 'vitest';
import { activeTakeIndex } from '@/project/comping';
import type { DocumentClip } from '@/project/document-schema';
import { applyDocumentClipMetadata } from '@/project/store-load';
import type { EditorClip } from '@/project/types';
import { trackActiveTakeIndex } from '@/ui/arrangement/automation-rows';

describe('activeTakeIndex', () => {
  it('uses the stored index and clamps it into the take range', () => {
    expect(activeTakeIndex(1, 3)).toBe(1);
    expect(activeTakeIndex(-2, 3)).toBe(0);
    expect(activeTakeIndex(9, 3)).toBe(2);
  });

  it('falls back to the last take when no index is stored', () => {
    expect(activeTakeIndex(undefined, 4)).toBe(3);
    expect(activeTakeIndex(Number.NaN, 4)).toBe(3);
  });

  it('floors fractional indices and returns 0 for no takes', () => {
    expect(activeTakeIndex(1.9, 3)).toBe(1);
    expect(activeTakeIndex(undefined, 0)).toBe(0);
  });
});

describe('MIDI take consumers follow the shared rule', () => {
  it('reports the last take as active for a MIDI clip without a stored index', () => {
    const clip = { trackId: 1, midiTakes: [{}, {}, {}] };
    expect(trackActiveTakeIndex([clip], 1)).toBe(2);
  });

  it('clamps an out-of-range stored index', () => {
    const clip = { trackId: 1, midiTakes: [{}, {}], midiActiveTakeIndex: 7 };
    expect(trackActiveTakeIndex([clip], 1)).toBe(1);
  });
});

describe('document load follows the shared rule', () => {
  const clip = {
    id: 1,
    trackId: 1,
    startPpq: 0,
    lengthPpq: 960,
    notes: [],
  } as unknown as EditorClip;
  const take = { name: 'Take', notes: [] };
  const load = (midiActiveTakeIndex: unknown) =>
    applyDocumentClipMetadata(
      [clip],
      new Map([
        [
          1,
          {
            name: 'Clip',
            kind: 'midi',
            midiTakes: [take, take, take],
            midiActiveTakeIndex,
          } as unknown as DocumentClip,
        ],
      ]),
    )[0];

  it('activates the last take when the document stores no index', () => {
    expect(load(undefined).midiActiveTakeIndex).toBe(2);
  });

  it('keeps and clamps a stored index', () => {
    expect(load(1).midiActiveTakeIndex).toBe(1);
    expect(load(9).midiActiveTakeIndex).toBe(2);
  });
});

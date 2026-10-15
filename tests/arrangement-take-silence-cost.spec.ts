import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { EditorClip } from '@/project/types';
import { useCommonTakeSilence } from '@/ui/arrangement/use-common-take-silence';

vi.mock('@/project/take-silence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/take-silence')>();
  return { ...actual, commonTakeSilence: vi.fn(async () => []) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function audioClip(id: number): EditorClip {
  return {
    id,
    trackId: 1,
    kind: 'audio',
    name: `c${id}`,
    startPpq: id * 8,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    takes: [
      { id: 1, assetId: 'a' },
      { id: 2, assetId: 'b' },
    ],
  } as unknown as EditorClip;
}

describe('useCommonTakeSilence scan keys', () => {
  it('serializes each clip takes and the tempo map once per refresh', async () => {
    const clips = [audioClip(1), audioClip(2), audioClip(3)];
    const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);
    const stringify = vi.spyOn(JSON, 'stringify');
    const silence = useCommonTakeSilence({
      clips: () => clips,
      expandedTrackIds: () => [1],
      tempo: () => tempo,
      deps: async () => ({}) as never,
    });
    await vi.waitFor(() => expect(silence.byClip.value.size).toBe(3));
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(clips.length + 1);
  });
});

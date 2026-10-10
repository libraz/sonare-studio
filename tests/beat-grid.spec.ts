import { describe, expect, it } from 'vitest';
import {
  fitBeatGrid,
  gridTempoSegments,
  onsetPhaseOffsetBeats,
  STEADY_TEMPO_MAX_DRIFT_BEATS,
} from '@/project/beat-grid';

/** Beats at `bpm` from `first` seconds, with an optional per-beat wobble. */
function beatsAt(bpm: number, count: number, first = 0.4, wobble = (_index: number) => 0) {
  return Array.from({ length: count }, (_, index) => first + (index * 60) / bpm + wobble(index));
}

describe('fitBeatGrid', () => {
  it('fits a steady tempo through jittered beats more closely than any one interval', () => {
    const beats = beatsAt(128.35, 300, 0.372, (index) => ((index % 3) - 1) * 0.004);
    const grid = fitBeatGrid(beats, [], 4);
    expect(grid?.bpm).toBeCloseTo(128.35, 1);
    expect(grid?.maxDriftBeats).toBeLessThan(STEADY_TEMPO_MAX_DRIFT_BEATS);
    expect(grid?.barBpms).toEqual([]);
  });

  it('starts the bar on the beat most detected downbeats fall on', () => {
    const beats = beatsAt(120, 32);
    // Downbeats on the third beat of the tracker's count, one of them misplaced.
    const downbeats = [beats[2], beats[6], beats[10], beats[13]];
    expect(fitBeatGrid(beats, downbeats, 4)?.downbeatSeconds).toBeCloseTo(beats[2], 9);
  });

  it('gives a drifting performance one tempo per bar', () => {
    // Accelerates from 100 to about 130 BPM.
    let time = 0;
    const beats = Array.from({ length: 64 }, (_, index) => {
      const at = time;
      time += 60 / (100 + index * 0.5);
      return at;
    });
    const grid = fitBeatGrid(beats, [beats[0]], 4);
    expect(grid?.maxDriftBeats).toBeGreaterThan(STEADY_TEMPO_MAX_DRIFT_BEATS);
    expect(grid?.barBpms.length).toBe(15);
    expect(grid?.barBpms[0]).toBeLessThan(grid?.barBpms.at(-1) ?? 0);
  });

  it('refuses fewer than two beats', () => {
    expect(fitBeatGrid([1], [], 4)).toBeNull();
  });
});

describe('gridTempoSegments', () => {
  it('is one tempo from the start when the tempo holds', () => {
    const grid = { bpm: 128.35, downbeatSeconds: 0.37, maxDriftBeats: 0.1, barBpms: [] };
    expect(gridTempoSegments(grid, 4, 4)).toEqual([{ startPpq: 0, bpm: 128.35 }]);
  });

  it('starts each bar tempo on its bar line from the downbeat', () => {
    const grid = { bpm: 110, downbeatSeconds: 1, maxDriftBeats: 1, barBpms: [100, 100, 120] };
    expect(gridTempoSegments(grid, 4, 4)).toEqual([
      { startPpq: 0, bpm: 100 },
      { startPpq: 12, bpm: 120 },
    ]);
  });
});

describe('onsetPhaseOffsetBeats', () => {
  it('finds a constant lag of the onsets behind the grid', () => {
    const onsets = Array.from({ length: 40 }, (_, index) => index * 0.5 + 0.09);
    expect(
      onsetPhaseOffsetBeats(
        onsets,
        onsets.map(() => 80),
      ),
    ).toBeCloseTo(0.09, 1);
  });

  it('weighs strong onsets above faint stray ones', () => {
    const strong = Array.from({ length: 20 }, (_, index) => index * 0.5 - 0.06);
    const faint = Array.from({ length: 30 }, (_, index) => index * 0.5 + 0.15);
    const offset = onsetPhaseOffsetBeats(
      [...strong, ...faint],
      [...strong.map(() => 100), ...faint.map(() => 10)],
    );
    expect(offset).toBeCloseTo(-0.06, 1);
  });
});

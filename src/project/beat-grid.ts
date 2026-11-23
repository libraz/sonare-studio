/**
 * Fits a recording's beat grid: its tempo, where its bars start, and how far
 * a detector's onsets sit off that grid.
 *
 * A one-shot tempo estimate drifts most of a beat over a long piece (measured:
 * 0.3 BPM off on a 158 s recording, 0.8 beat by the end), so the tempo is a
 * least-squares line through the tracked beats instead. A recording whose
 * beats stray from that line is given one tempo per bar. Times are seconds
 * from the start of the analysed window. Pure module.
 */

import { maxOf } from '@/lib/math';
import type { TempoSegment } from './types';

/** Beats further than this off the fitted line make the tempo per-bar. */
export const STEADY_TEMPO_MAX_DRIFT_BEATS = 0.25;

export interface BeatGrid {
  /** Tempo of the fitted line. */
  bpm: number;
  /** The first beat that starts a bar, in seconds. */
  downbeatSeconds: number;
  /** Worst distance of a tracked beat from the fitted line, in beats. */
  maxDriftBeats: number;
  /**
   * One tempo per bar from the first downbeat, in bars, when the tempo moves;
   * empty when one tempo holds.
   */
  barBpms: number[];
}

function ascending(times: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (const time of Array.from(times)) {
    if (Number.isFinite(time) && (out.length === 0 || time > out[out.length - 1])) out.push(time);
  }
  return out;
}

/**
 * Fits the grid from tracked beats and downbeats.
 *
 * @param beats Beat times in seconds.
 * @param downbeats Downbeat times in seconds; they choose which beat of the bar
 *   is the first, by majority over the fitted beats.
 * @param beatsPerBar Beats in one bar of the project meter.
 * @returns The grid, or null with fewer than two usable beats.
 */
export function fitBeatGrid(
  beats: ArrayLike<number>,
  downbeats: ArrayLike<number>,
  beatsPerBar: number,
): BeatGrid | null {
  const times = ascending(beats);
  if (times.length < 2 || !(beatsPerBar >= 1)) return null;
  const n = times.length;
  const meanIndex = (n - 1) / 2;
  const meanTime = times.reduce((sum, time) => sum + time, 0) / n;
  let covariance = 0;
  let variance = 0;
  times.forEach((time, index) => {
    covariance += (index - meanIndex) * (time - meanTime);
    variance += (index - meanIndex) ** 2;
  });
  const period = covariance / variance;
  if (!(period > 0)) return null;
  const origin = meanTime - period * meanIndex;
  const maxDriftBeats = maxOf(
    times.map((time, index) => Math.abs(time - (origin + period * index)) / period),
  );

  // Vote each detected downbeat onto the beat index it falls nearest.
  const votes = new Array<number>(beatsPerBar).fill(0);
  for (const downbeat of ascending(downbeats)) {
    const index = Math.round((downbeat - origin) / period);
    if (index >= 0 && index < n) votes[((index % beatsPerBar) + beatsPerBar) % beatsPerBar] += 1;
  }
  const phase = votes.indexOf(maxOf(votes));
  const downbeatSeconds = times[phase] ?? origin + period * phase;

  const barBpms: number[] = [];
  if (maxDriftBeats > STEADY_TEMPO_MAX_DRIFT_BEATS) {
    for (let index = phase; index + beatsPerBar < n; index += beatsPerBar) {
      barBpms.push((60 * beatsPerBar) / (times[index + beatsPerBar] - times[index]));
    }
  }
  return {
    bpm: 60 / period,
    downbeatSeconds,
    maxDriftBeats,
    barBpms,
  };
}

/**
 * The project tempo map that puts a grid's first downbeat on `downbeatPpq`:
 * one tempo from the start when the tempo holds, else the first bar's tempo up
 * to the downbeat and one segment per bar after it.
 */
export function gridTempoSegments(
  grid: BeatGrid,
  downbeatPpq: number,
  beatsPerBar: number,
): TempoSegment[] {
  const round = (bpm: number): number => Math.round(bpm * 1000) / 1000;
  if (grid.barBpms.length === 0) return [{ startPpq: 0, bpm: round(grid.bpm) }];
  const segments: TempoSegment[] = [{ startPpq: 0, bpm: round(grid.barBpms[0]) }];
  grid.barBpms.forEach((bpm, bar) => {
    const startPpq = downbeatPpq + bar * beatsPerBar;
    if (round(bpm) !== segments[segments.length - 1].bpm && startPpq > 0) {
      segments.push({ startPpq, bpm: round(bpm) });
    }
  });
  return segments;
}

/**
 * How far detected onsets sit off the beat grid, in beats: the weighted
 * circular mean of their phase on the eighth-note grid, so the answer lies
 * within a quarter beat either way. Read on eighths rather than sixteenths,
 * which would lock onto the off-sixteenths.
 *
 * @param onsets Onset positions in beats, on the grid's own coordinates.
 * @param weights Per-onset weight (velocity), index-aligned.
 * @returns The shift to add to the grid, in beats.
 */
export function onsetPhaseOffsetBeats(
  onsets: readonly number[],
  weights: readonly number[],
): number {
  const EIGHTH = 0.5;
  let sin = 0;
  let cos = 0;
  onsets.forEach((onset, index) => {
    const angle = (2 * Math.PI * onset) / EIGHTH;
    const weight = weights[index] ?? 1;
    sin += weight * Math.sin(angle);
    cos += weight * Math.cos(angle);
  });
  if (sin === 0 && cos === 0) return 0;
  return (Math.atan2(sin, cos) / (2 * Math.PI)) * EIGHTH;
}

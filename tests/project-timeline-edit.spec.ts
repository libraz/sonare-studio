import { describe, expect, it } from 'vitest';
import {
  deleteAutomationLanes,
  deleteChordSymbols,
  deleteMarkers,
  deleteSections,
  deleteTimelineSegments,
  duplicateChordSymbols,
  insertAutomationLanes,
  insertChordSymbols,
  insertMarkers,
  insertSections,
  insertTimelineSegments,
} from '@/project/timeline-edit';

describe('timeline metadata transforms', () => {
  const chord = (startPpq: number, endPpq: number, rootPc: number) => ({
    startPpq,
    endPpq,
    rootPc,
    quality: 0,
    extensions: [9],
    omissions: [4],
    romanNumeral: `I${rootPc}`,
  });

  it('splits chords around inserted time and preserves theory metadata', () => {
    expect(insertChordSymbols([chord(0, 8, 0), chord(8, 12, 5)], 4, 2)).toEqual([
      chord(0, 4, 0),
      chord(6, 10, 0),
      chord(10, 14, 5),
    ]);
  });

  it('crops chords at a deleted range while keeping both surviving sides', () => {
    expect(deleteChordSymbols([chord(0, 8, 0), chord(8, 12, 5)], 2, 6)).toEqual([
      chord(0, 2, 0),
      chord(2, 4, 0),
      chord(4, 8, 5),
    ]);
  });

  it('duplicates only the source intersections and ripples later chord regions', () => {
    expect(duplicateChordSymbols([chord(0, 8, 0), chord(8, 12, 5)], 2, 6)).toEqual([
      chord(0, 6, 0),
      chord(6, 10, 0),
      chord(10, 12, 0),
      chord(12, 16, 5),
    ]);
  });

  it('shifts markers and expands sections across inserted time', () => {
    expect(
      insertMarkers(
        [
          { id: 1, ppq: 0, name: 'Start' },
          { id: 2, ppq: 4, name: 'Verse' },
        ],
        0,
        2,
      ),
    ).toEqual([
      { id: 1, ppq: 2, name: 'Start' },
      { id: 2, ppq: 6, name: 'Verse' },
    ]);
    expect(
      insertSections(
        [
          { id: 1, name: 'Intro', color: '#111', startPpq: 0, endPpq: 4 },
          { id: 2, name: 'Verse', color: '#222', startPpq: 4, endPpq: 8 },
        ],
        2,
        2,
      ),
    ).toEqual([
      { id: 1, name: 'Intro', color: '#111', startPpq: 0, endPpq: 6 },
      { id: 2, name: 'Verse', color: '#222', startPpq: 6, endPpq: 10 },
    ]);
  });

  it('clips, drops and shifts section and marker regions on deletion', () => {
    expect(
      deleteMarkers(
        [
          { id: 1, ppq: 1, name: 'A' },
          { id: 2, ppq: 3, name: 'B' },
          { id: 3, ppq: 7, name: 'C' },
        ],
        2,
        6,
      ),
    ).toEqual([
      { id: 1, ppq: 1, name: 'A' },
      { id: 3, ppq: 3, name: 'C' },
    ]);
    expect(
      deleteSections(
        [
          { id: 1, name: 'Left', color: '#111', startPpq: 0, endPpq: 3 },
          { id: 2, name: 'Inside', color: '#222', startPpq: 3, endPpq: 5 },
          { id: 3, name: 'Across', color: '#333', startPpq: 1, endPpq: 8 },
          { id: 4, name: 'Right', color: '#444', startPpq: 7, endPpq: 9 },
        ],
        2,
        6,
      ),
    ).toEqual([
      { id: 1, name: 'Left', color: '#111', startPpq: 0, endPpq: 2 },
      { id: 3, name: 'Across', color: '#333', startPpq: 1, endPpq: 4 },
      { id: 4, name: 'Right', color: '#444', startPpq: 3, endPpq: 5 },
    ]);
  });

  it('preserves the held automation value at a ripple-delete boundary', () => {
    const lanes = [
      {
        target: 'master' as const,
        param: 'faderDb' as const,
        enabled: true,
        points: [
          { ppq: 0, value: -6 },
          { ppq: 3, value: -3, curve: 's-curve' as const },
          { ppq: 5, value: 0 },
          { ppq: 8, value: -9 },
        ],
      },
    ];
    expect(insertAutomationLanes(lanes, 4, 2)[0].points.map((point) => point.ppq)).toEqual([
      0, 3, 7, 10,
    ]);
    expect(insertAutomationLanes(lanes, 0, 2)[0].points.map((point) => point.ppq)).toEqual([
      0, 5, 7, 10,
    ]);
    expect(deleteAutomationLanes(lanes, 4, 7)[0].points).toEqual([
      { ppq: 0, value: -6 },
      { ppq: 3, value: -3, curve: 's-curve' },
      { ppq: 4, value: -3, curve: 's-curve' },
      { ppq: 5, value: -9 },
    ]);
  });

  it('retains active tempo/meter values through a deleted map boundary', () => {
    const tempo = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 90 },
      { startPpq: 6, bpm: 140 },
      { startPpq: 10, bpm: 110 },
    ];
    expect(insertTimelineSegments(tempo, 4, 2)).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 6, bpm: 90 },
      { startPpq: 8, bpm: 140 },
      { startPpq: 12, bpm: 110 },
    ]);
    expect(insertTimelineSegments(tempo, 0, 2)).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 6, bpm: 90 },
      { startPpq: 8, bpm: 140 },
      { startPpq: 12, bpm: 110 },
    ]);
    expect(deleteTimelineSegments(tempo, 5, 9)).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 90 },
      { startPpq: 6, bpm: 110 },
    ]);

    const meter = [
      { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      { startPpq: 4, numerator: 4, denominator: 4 },
    ];
    expect(deleteTimelineSegments(meter, 0, 2)).toEqual([
      { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
      { startPpq: 2, numerator: 4, denominator: 4 },
    ]);
  });
});

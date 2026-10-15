import { describe, expect, it } from 'vitest';
import { importMusicXml } from '@/notation/musicxml-import';

function tempoXml(beatUnit: string): string {
  return (
    '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
    '<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' +
    `<direction><direction-type><metronome><beat-unit>${beatUnit}</beat-unit>` +
    '<per-minute>10</per-minute></metronome></direction-type></direction>' +
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' +
    '</measure></part></score-partwise>'
  );
}

describe('metronome beat units', () => {
  it.each([
    ['breve', 80],
    ['whole', 40],
    ['half', 20],
    ['quarter', 10],
    ['eighth', 5],
    ['16th', 2.5],
    ['32nd', 1.25],
    ['64th', 0.625],
  ])('converts a %s beat unit to quarter-note BPM', (unit, bpm) => {
    expect(importMusicXml(tempoXml(unit)).tempoSegments[0]?.bpm).toBe(bpm);
  });
});

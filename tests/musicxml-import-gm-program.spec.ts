import { describe, expect, it } from 'vitest';
import { importMusicXml } from '@/notation/musicxml-import';
import { presetForGmProgram } from '@/project/instrument';

function instrumentFor(program: number, channel: number) {
  const xml =
    '<score-partwise><part-list><score-part id="P1"><part-name>Part</part-name>' +
    `<midi-instrument id="P1-I1"><midi-channel>${channel + 1}</midi-channel>` +
    `<midi-program>${program + 1}</midi-program></midi-instrument></score-part></part-list>` +
    '<part id="P1"><measure><attributes><divisions>1</divisions></attributes>' +
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>' +
    '<instrument id="P1-I1"/></note></measure></part></score-partwise>';
  return importMusicXml(xml).tracks[0].instrument;
}

describe('MusicXML GM program mapping', () => {
  it.each([
    [4, 0],
    [5, 0],
    [20, 1],
    [60, 2],
    [0, 9],
  ])('maps program %i on channel %i like the SMF importer', (program, channel) => {
    expect(instrumentFor(program, channel)).toEqual({
      kind: 'synth-preset',
      preset: presetForGmProgram(program, channel),
      useGmPrograms: true,
      gmProgram: program,
    });
  });
});

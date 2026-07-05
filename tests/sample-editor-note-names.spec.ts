import { describe, expect, it } from 'vitest';
import { formatMidiNote, parseMidiNote } from '@/ui/sample-editor/note-names';

describe('parseMidiNote', () => {
  it('parses scientific note names with C4 = 60', () => {
    expect(parseMidiNote('C4')).toBe(60);
    expect(parseMidiNote('A4')).toBe(69);
    expect(parseMidiNote('C-1')).toBe(0);
    expect(parseMidiNote('G9')).toBe(127);
  });

  it('applies sharps and flats, including unicode accidentals', () => {
    expect(parseMidiNote('C#4')).toBe(61);
    expect(parseMidiNote('Db4')).toBe(61);
    expect(parseMidiNote('C♯4')).toBe(61);
    expect(parseMidiNote('D♭4')).toBe(61);
  });

  it('is case-insensitive on the letter and tolerates whitespace', () => {
    expect(parseMidiNote('a4')).toBe(69);
    expect(parseMidiNote('  c#3 ')).toBe(49);
  });

  it('treats a bare integer as a MIDI number', () => {
    expect(parseMidiNote('60')).toBe(60);
    expect(parseMidiNote('0')).toBe(0);
    expect(parseMidiNote('127')).toBe(127);
  });

  it('rejects empty, unparseable or out-of-range input', () => {
    expect(parseMidiNote('')).toBeNull();
    expect(parseMidiNote('   ')).toBeNull();
    expect(parseMidiNote('H4')).toBeNull();
    expect(parseMidiNote('128')).toBeNull();
    expect(parseMidiNote('C12')).toBeNull();
    expect(parseMidiNote('C')).toBeNull();
    expect(parseMidiNote('Cbb4')).toBeNull();
  });
});

describe('formatMidiNote', () => {
  it('formats MIDI numbers as note names with sharps', () => {
    expect(formatMidiNote(60)).toBe('C4');
    expect(formatMidiNote(69)).toBe('A4');
    expect(formatMidiNote(61)).toBe('C#4');
    expect(formatMidiNote(0)).toBe('C-1');
  });

  it('rounds to the nearest integer note', () => {
    expect(formatMidiNote(60.4)).toBe('C4');
    expect(formatMidiNote(60.6)).toBe('C#4');
  });
});

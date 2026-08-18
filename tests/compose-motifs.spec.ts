import { describe, expect, it } from 'vitest';
import { analyzeMotifs } from '@/compose/motifs';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorNote } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

/**
 * Which figure a piece restates is a reading, so these pin the shape of the
 * answer, the exclusions and the positioning — plus the one judgement this
 * module makes on top of the library: collapsing the overlapping windows the
 * search reports for a single figure.
 */

let nextId = 1;

function note(pitch: number, startPpq: number, durationPpq = 1): EditorNote {
  return { id: nextId++, pitch, startPpq, durationPpq, velocity: 100, channel: 0 };
}

function track(name: string, notes: EditorNote[], extra: Record<string, unknown> = {}) {
  return {
    track: { id: 1, name, color: '#fff', kind: 'midi', mute: false, solo: false, ...extra },
    notes,
  } as unknown as TrackWithNotes;
}

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

/**
 * Two figures far enough apart not to overlap: a rising cell stated twice, then
 * that cell upside down stated twice.
 */
function figureAndItsInversion(): EditorNote[] {
  const rising = [0, 2, 4, 2];
  const notes: EditorNote[] = [];
  for (let statement = 0; statement < 2; statement += 1) {
    rising.forEach((degree, index) => {
      notes.push(note(60 + statement * 2 + degree, statement * 4 + index));
    });
  }
  for (let statement = 0; statement < 2; statement += 1) {
    rising.forEach((degree, index) => {
      notes.push(note(72 - statement * 2 - degree, 16 + statement * 4 + index));
    });
  }
  return notes;
}

/** A four-note figure stated three times, each a whole step up from the last. */
function risingSequence(): EditorNote[] {
  const figure = [0, 2, 4, 2];
  const notes: EditorNote[] = [];
  for (let statement = 0; statement < 3; statement += 1) {
    figure.forEach((degree, index) => {
      notes.push(note(60 + statement * 2 + degree, statement * 4 + index));
    });
  }
  // A contrasting tail so the piece is not made of the figure alone.
  [67, 65, 64, 62, 60].forEach((pitch, index) => {
    notes.push(note(pitch, 12 + index));
  });
  return notes;
}

describe('analyzeMotifs', () => {
  it('reads nothing from a track with no notes', () => {
    expect(analyzeMotifs([track('Lead', [])])).toEqual({ tracks: [], excludedTrackNames: [] });
  });

  it('finds a restated figure and positions every statement in absolute PPQ', () => {
    const { tracks } = analyzeMotifs([track('Lead', risingSequence())], C_MAJOR);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].trackName).toBe('Lead');
    const first = tracks[0].motifs[0];
    expect(first.noteCount).toBeGreaterThanOrEqual(3);
    expect(first.statements.length).toBeGreaterThanOrEqual(2);
    expect(first.statements[0].startPpq).toBe(0);
    for (const statement of first.statements) {
      expect(statement.endPpq).toBeGreaterThan(statement.startPpq);
    }
    // Statements are in time order and the second stands above the first.
    expect(first.statements[1].startPpq).toBeGreaterThan(first.statements[0].startPpq);
    expect(first.statements[0].transpose).toBe(0);
  });

  /**
   * The search reports the window starting one note later as its own figure, so
   * without this the panel would show the same figure four times over.
   */
  it('collapses the overlapping windows of one figure into a single entry', () => {
    const { tracks } = analyzeMotifs([track('Lead', risingSequence())], C_MAJOR);
    const spans = tracks[0].motifs.flatMap((motif) => motif.statements);

    for (const [index, span] of spans.entries()) {
      for (const other of spans.slice(index + 1)) {
        expect(span.startPpq >= other.endPpq || span.endPpq <= other.startPpq).toBe(true);
      }
    }
  });

  it('reports at most a readable number of figures per track', () => {
    const { tracks } = analyzeMotifs([track('Lead', risingSequence())], C_MAJOR);
    expect(tracks[0].motifs.length).toBeLessThanOrEqual(4);
  });

  it('names the transformation between two figures', () => {
    const { tracks } = analyzeMotifs([track('Lead', figureAndItsInversion())], C_MAJOR);
    const known = [
      'repetition',
      'transposition',
      'tonalTransposition',
      'inversion',
      'retrograde',
      'retrogradeInversion',
      'augmentation',
      'diminution',
    ];

    expect(tracks[0].motifs.length).toBeGreaterThanOrEqual(2);
    expect(tracks[0].relations.length).toBeGreaterThan(0);
    for (const relation of tracks[0].relations) {
      expect(known).toContain(relation.kind);
      expect(relation.toIndex).toBeGreaterThan(relation.fromIndex);
      expect(tracks[0].motifs[relation.fromIndex]).toBeDefined();
      expect(tracks[0].motifs[relation.toIndex]).toBeDefined();
    }
  });

  /**
   * The library states its reading in English prose, which an editor that runs
   * in more than one language cannot show. The reading is reported as the facts
   * the prose recites instead, so the display can write them in its own words.
   */
  it('reports the shape a figure traces and whether its statements move', () => {
    const shapes = ['arch', 'ascending', 'descending', 'wave', 'static'];
    const rising = analyzeMotifs([track('Lead', risingSequence())], C_MAJOR).tracks[0];

    for (const motif of rising.motifs) expect(shapes).toContain(motif.shape);
    // A sequence restates its cell at a new pitch every time.
    expect(rising.motifs[0].transposed).toBe(true);
    expect(rising.motifs[0].statements.some((statement) => statement.transpose !== 0)).toBe(true);
  });

  it('reads a figure restated at one pitch as untransposed', () => {
    const repeated: EditorNote[] = [];
    for (const at of [0, 4, 8]) {
      repeated.push(note(60, at), note(64, at + 1), note(67, at + 2), note(64, at + 3));
    }
    const { tracks } = analyzeMotifs([track('Lead', repeated)], C_MAJOR);

    expect(tracks[0].motifs[0].transposed).toBe(false);
    expect(tracks[0].motifs[0].shape).toBe('arch');
  });

  // A cell of drum hits is a groove, not a figure.
  it('excludes percussion tracks and reports them by name', () => {
    const drums = track('Drums', [note(36, 0), note(38, 1), note(36, 2), note(38, 3)], {
      percussion: true,
    });
    const report = analyzeMotifs([track('Lead', risingSequence()), drums], C_MAJOR);

    expect(report.excludedTrackNames).toEqual(['Drums']);
    expect(report.tracks.map((entry) => entry.trackName)).toEqual(['Lead']);
  });

  /**
   * A chord's inner notes are not a line; without the reduction a block-chord
   * track reports figures made of voices that never sounded in succession.
   */
  it('reads a chord track as its top voice', () => {
    // Top notes spell one figure twice; the inner voices do not, so a reading
    // that pooled every note would not find it.
    const tops = [67, 72, 74, 72, 67, 72, 74, 72];
    const chords: EditorNote[] = [];
    tops.forEach((top, index) => {
      for (const below of [0, 5, 9]) chords.push(note(top - below, index * 2, 2));
    });
    const { tracks } = analyzeMotifs([track('Keys', chords)], C_MAJOR);

    expect(tracks).toHaveLength(1);
    const statements = tracks[0].motifs[0].statements;
    expect(statements.length).toBeGreaterThanOrEqual(2);
    // Each statement spans whole chords, not notes inside one.
    for (const statement of statements) {
      expect(statement.endPpq - statement.startPpq).toBeGreaterThanOrEqual(4);
    }
  });

  // A figure is an interval pattern that comes back; a line whose every step is
  // a different size has none, and is reported as having none rather than as
  // having a weak one.
  it('reads a line that never restates anything as having no figure', () => {
    const line = [60, 61, 63, 66, 70, 75, 81, 88].map((pitch, index) => note(pitch, index));
    expect(analyzeMotifs([track('Lead', line)], C_MAJOR).tracks).toEqual([]);
  });
});

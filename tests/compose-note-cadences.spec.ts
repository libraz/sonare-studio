import { makeChord } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildTheoryCard, theoryLabelsFor } from '@/compose/explain';
import { buildGuidance, type GuidanceInput, type NoteAnalysis } from '@/compose/guidance';
import {
  cadencesFromNotes,
  isSegmentationTrustworthy,
  SEGMENT_REGULARITY_MIN,
  segmentationQuality,
} from '@/compose/note-cadences';
import { editorNotesToNoteEvents } from '@/compose/notes-io';
import type { VoiceLine } from '@/compose/voice-context';
import type { EditorChordSymbol } from '@/project/chords';
import bwv565 from '@/project/demo/bwv565.json';
import type { EditorNote, ScaleHighlightConfig, TimeSignatureSegment } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';
import { MESSAGES } from '@/ui/i18n';

/**
 * The cadence line is only as good as the harmony under it. These pin the two
 * standings it can have — stated by a chord track, or read out of the notes —
 * the measure that decides whether a reading is worth showing at all, and how
 * few notes an arrival reaches.
 */

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
const C_MAJOR: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const EN_LABELS = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);

let nextId = 1;
function note(pitch: number, startPpq: number, durationPpq = 1): EditorNote {
  return { id: nextId++, pitch, startPpq, durationPpq, velocity: 100, channel: 0 };
}

/**
 * Four four-bar units of a I-IV-V-I turn, each closing with a held tonic — the
 * homophonic case, where reading the harmony back out of the notes lands on the
 * same beats the written progression does (mirrors the phrase-analysis fixture).
 */
function periodicMelody(): EditorNote[] {
  const notes: EditorNote[] = [];
  for (let unit = 0; unit < 4; unit += 1) {
    const at = unit * 16;
    notes.push(note(60, at), note(64, at + 1), note(67, at + 2), note(72, at + 3));
    notes.push(note(65, at + 4), note(69, at + 5), note(72, at + 6), note(69, at + 7));
    notes.push(note(67, at + 8), note(71, at + 9), note(74, at + 10), note(71, at + 11));
    notes.push(note(60, at + 12, 4));
  }
  return notes;
}

/** A I-IV-V-I progression per four-bar unit, four units long. */
function turnaround(): EditorChordSymbol[] {
  const chords: EditorChordSymbol[] = [];
  for (let unit = 0; unit < 4; unit += 1) {
    const at = unit * 16;
    chords.push({ startPpq: at, endPpq: at + 4, rootPc: 0, quality: 0 });
    chords.push({ startPpq: at + 4, endPpq: at + 8, rootPc: 5, quality: 0 });
    chords.push({ startPpq: at + 8, endPpq: at + 12, rootPc: 7, quality: 4 });
    chords.push({ startPpq: at + 12, endPpq: at + 16, rootPc: 0, quality: 0 });
  }
  return chords;
}

function guidanceInput(partial: Partial<GuidanceInput>): GuidanceInput {
  return {
    notes: [],
    clipStartPpq: 0,
    clipLengthPpq: 64,
    chordSymbols: [],
    key: C_MAJOR,
    timeSignatures: FOUR_FOUR,
    ...partial,
  };
}

/** Onsets of the notes the analysis gave a cadence line to, in time order. */
function cadenceOnsets(notes: ReadonlyArray<EditorNote>, byNoteId: Map<number, NoteAnalysis>) {
  return notes
    .filter((item) => byNoteId.get(item.id)?.cadence !== undefined)
    .map((item) => ({ at: item.startPpq, ...byNoteId.get(item.id)?.cadence }))
    .sort((a, b) => a.at - b.at);
}

/** The card's cadence line for one analyzed note, or undefined. */
function cadenceLine(analysis: NoteAnalysis) {
  const card = buildTheoryCard(analysis, { pitch: 60, keySet: true }, EN_LABELS);
  return card.lines.find((line) => line.label === MESSAGES.en.harmony.cadence.label);
}

interface Bwv565Asset {
  lengthPpq: number;
  timeSignatures: TimeSignatureSegment[];
  tracks: Array<{ name: string; notes: Array<[number, number, number, number]> }>;
}
const BACH = bwv565 as unknown as Bwv565Asset;

/** One BWV 565 voice as editor notes, ids kept unique across the voices. */
function bachVoice(index: number): EditorNote[] {
  return BACH.tracks[index].notes.map(([pitch, velocity, startPpq, durationPpq], position) => ({
    id: index * 100000 + position + 1,
    pitch,
    velocity,
    startPpq,
    durationPpq,
    channel: index,
  }));
}

function bachTrack(index: number): VoiceLine {
  return { trackId: index + 1, role: 'melodic', notes: bachVoice(index) };
}

describe('cadences from a chord track', () => {
  it('names the arrival on the note that sounds it, without hedging', () => {
    const notes = periodicMelody();
    const { byNoteId } = buildGuidance(
      guidanceInput({ notes, chordSymbols: turnaround(), clipLengthPpq: 64 }),
    );

    // The written progression arrives twice per four-bar unit: on the dominant
    // at beat 8 of the unit (a half cadence) and back on the tonic at beat 12.
    expect(cadenceOnsets(notes, byNoteId)).toEqual([
      { at: 8, type: 'half', inferred: false },
      { at: 12, type: 'authentic', inferred: false },
      { at: 24, type: 'half', inferred: false },
      { at: 28, type: 'authentic', inferred: false },
      { at: 40, type: 'half', inferred: false },
      { at: 44, type: 'authentic', inferred: false },
      { at: 56, type: 'half', inferred: false },
      { at: 60, type: 'authentic', inferred: false },
    ]);
  });

  it('writes the arrival plainly on the card and says nothing on the notes around it', () => {
    const notes = periodicMelody();
    const { byNoteId } = buildGuidance(guidanceInput({ notes, chordSymbols: turnaround() }));

    const arrival = notes.find((item) => item.startPpq === 12);
    const line = cadenceLine(byNoteId.get(arrival?.id ?? -1) as NoteAnalysis);
    expect(line?.text).toBe('Authentic cadence — the phrase closes here');
    expect(line?.badge).toBeUndefined();

    // The note a beat before the arrival, and the one starting the piece, carry
    // no cadence: the line belongs to the arrival, not to the chord over it.
    for (const away of [0, 11]) {
      const other = notes.find((item) => item.startPpq === away);
      const analysis = byNoteId.get(other?.id ?? -1) as NoteAnalysis;
      expect(analysis.cadence).toBeUndefined();
      expect(cadenceLine(analysis)).toBeUndefined();
    }
  });
});

describe('cadences inferred from the notes', () => {
  it('reads the same arrivals the written progression states, and marks them inferred', () => {
    const notes = periodicMelody();
    const authored = buildGuidance(guidanceInput({ notes, chordSymbols: turnaround() }));
    const inferred = buildGuidance(guidanceInput({ notes }));

    const authoredArrivals = cadenceOnsets(notes, authored.byNoteId);
    const inferredArrivals = cadenceOnsets(notes, inferred.byNoteId);
    expect(inferredArrivals.length).toBeGreaterThan(0);
    for (const arrival of inferredArrivals) {
      expect(arrival.inferred).toBe(true);
      // Every inferred arrival lands on a beat the written progression also
      // arrives on, with the same reading. The phrase ranking keeps the
      // structural ones, so the inferred set is the smaller of the two.
      expect(authoredArrivals).toContainEqual({
        at: arrival.at,
        type: arrival.type,
        inferred: false,
      });
    }
  });

  it('hedges the inferred arrival on the card', () => {
    const notes = periodicMelody();
    const { byNoteId } = buildGuidance(guidanceInput({ notes }));
    const arrival = notes.find((item) => item.startPpq === 12);
    const line = cadenceLine(byNoteId.get(arrival?.id ?? -1) as NoteAnalysis);

    expect(line?.text).toBe('Authentic cadence — the phrase closes here');
    expect(line?.badge).toBe(MESSAGES.en.theory.inferred);
  });

  it('pools every sounding voice rather than the clip being edited', () => {
    // The melody alone is a single line; the harmony that names its cadences is
    // in the accompaniment, which lives on another track.
    const melody = [note(72, 0, 4), note(71, 4, 4), note(72, 8, 4), note(72, 12, 4)];
    const accompaniment: EditorNote[] = [];
    for (const [at, tones] of [
      [0, [48, 55, 64]],
      [4, [53, 57, 65]],
      [8, [55, 59, 67]],
      [12, [48, 55, 64]],
    ] as Array<[number, number[]]>) {
      for (const pitch of tones) accompaniment.push(note(pitch, at, 4));
    }
    const withAccompaniment = buildGuidance(
      guidanceInput({
        notes: melody,
        clipLengthPpq: 16,
        lines: [{ trackId: 2, role: 'melodic', notes: accompaniment }],
      }),
    );
    const alone = buildGuidance(guidanceInput({ notes: melody, clipLengthPpq: 16 }));

    expect(cadenceOnsets(melody, withAccompaniment.byNoteId).length).toBeGreaterThan(0);
    expect(cadenceOnsets(melody, alone.byNoteId)).toEqual([]);
  });
});

describe('the segmentation gate', () => {
  it('measures a homophonic reading as regular', () => {
    const events = editorNotesToNoteEvents(periodicMelody());
    const { quality, trusted, arrivals } = cadencesFromNotes(events, FOUR_FOUR);

    expect(quality.regularity).toBe(1);
    expect(quality.medianBeats).toBe(4);
    expect(quality.harmonicRhythmBeats).toBe(4);
    expect(quality.regularity - SEGMENT_REGULARITY_MIN).toBeGreaterThan(0.2);
    expect(trusted).toBe(true);
    expect(arrivals.length).toBeGreaterThan(0);
  });

  it('measures the arpeggiated toccata as irregular and reports nothing from it', () => {
    const events = editorNotesToNoteEvents([0, 1, 2, 3].flatMap((index) => bachVoice(index)));
    const { quality, trusted, arrivals } = cadencesFromNotes(events, BACH.timeSignatures);

    // 139 segments of 1 to 30 beats against a median of 2: the inference is
    // tracking the arpeggios' pitch-class histogram, not a harmonic rhythm.
    expect(quality.segmentCount).toBeGreaterThan(100);
    expect(quality.medianBeats).toBe(2);
    expect(quality.regularity).toBeCloseTo(0.42, 2);
    // Stated as a margin so lowering the threshold to let this material through
    // fails here rather than quietly labelling 3795 notes.
    expect(SEGMENT_REGULARITY_MIN - quality.regularity).toBeGreaterThan(0.2);
    expect(trusted).toBe(false);
    expect(arrivals).toEqual([]);
  });

  it('refuses a reading that found no harmonic rhythm at all', () => {
    // Dense counterpoint that collapses to one chord over the whole span is
    // perfectly regular and says nothing; the median-against-the-bar guard is
    // what rejects it.
    const oneSegment = [{ startBeat: 0, endBeat: 64, chord: makeChord(0, 'maj') }];
    expect(segmentationQuality(oneSegment, 4).medianBeats).toBe(64);
    expect(
      isSegmentationTrustworthy({
        regularity: 1,
        medianBeats: 64,
        harmonicRhythmBeats: 4,
        segmentCount: 1,
      }),
    ).toBe(false);
    expect(
      isSegmentationTrustworthy({
        regularity: 1,
        medianBeats: 4,
        harmonicRhythmBeats: 4,
        segmentCount: 16,
      }),
    ).toBe(true);
  });
});

describe('how far an arrival reaches', () => {
  it('reaches the notes sounding the arrival and no others', () => {
    const notes = periodicMelody();
    const authored = buildGuidance(guidanceInput({ notes, chordSymbols: turnaround() }));
    const inferred = buildGuidance(guidanceInput({ notes }));

    // One note per arrival: the arrival window is half a beat of the meter in
    // force, so the note before and the note after are never swept in.
    const authoredMarked = cadenceOnsets(notes, authored.byNoteId).length;
    const inferredMarked = cadenceOnsets(notes, inferred.byNoteId).length;
    expect(authoredMarked).toBe(8);
    expect(authoredMarked / notes.length).toBeLessThan(0.2);
    expect(inferredMarked / notes.length).toBeLessThan(0.2);
  });

  it('credits each inferred half cadence to the dominant bar it closes', () => {
    // A dominant held through a bar closes its phrase on that bar, so the
    // inferred reading ranks the half cadences beside the authentic ones.
    const notes = periodicMelody();
    const inferred = cadenceOnsets(notes, buildGuidance(guidanceInput({ notes })).byNoteId);
    expect(inferred.filter((onset) => onset.type === 'half').map((onset) => onset.at)).toEqual([
      8, 24, 40, 56,
    ]);
    expect(inferred.filter((onset) => onset.type === 'authentic').map((onset) => onset.at)).toEqual(
      expect.arrayContaining([12, 28, 44]),
    );
  });

  // libcantus gives a lone held tonic that ends the piece no timeline segment,
  // so the authentic cadence into the final bar is lost.
  it.fails('closes the inferred reading on the final authentic cadence', () => {
    const notes = periodicMelody();
    const inferred = cadenceOnsets(notes, buildGuidance(guidanceInput({ notes })).byNoteId);
    expect(inferred).toContainEqual(expect.objectContaining({ at: 60, type: 'authentic' }));
  });

  it('gives the arpeggiated toccata no cadence line anywhere', () => {
    const active = bachVoice(0);
    const { byNoteId } = buildGuidance({
      notes: active,
      clipStartPpq: 0,
      clipLengthPpq: BACH.lengthPpq,
      chordSymbols: [],
      key: { enabled: true, rootPc: 2, modeMask: 1453 },
      timeSignatures: BACH.timeSignatures,
      lines: [bachTrack(1), bachTrack(2), bachTrack(3)],
    });

    expect(byNoteId.size).toBe(active.length);
    expect(cadenceOnsets(active, byNoteId)).toEqual([]);
  });
});

/**
 * Counterpoint verdicts over the whole BWV 565 demo: four monophonic organ
 * voices, no chord track, so every reading comes from the voices alone. The
 * counts are pinned because they are the only place the doubling suppression
 * can be seen at the scale it was written for — the toccata opens on octave
 * doubling for dozens of bars, and a regression there is silent on any
 * hand-built fixture.
 */

import { ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildGuidance } from '@/compose/guidance';
import { detectScaleHighlightFromTracks } from '@/compose/key';
import type { TrackWithNotes } from '@/compose/tracks';
import { makeBwv565Document } from '@/project/demo/bwv565';
import type { EditorNote, EditorTrack, ScaleHighlightConfig } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

/** The demo carries no key of its own; the counterpoint reasons are key-free. */
const NO_KEY: ScaleHighlightConfig = { enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK };

/** One voice of the demo as the editing surfaces see it: a track and its notes. */
interface DemoVoice {
  track: EditorTrack;
  notes: EditorNote[];
  lengthPpq: number;
}

/**
 * The demo document read as the note-editing surfaces read it: one clip per
 * voice starting at the timeline origin with no loop, so the projector's output
 * is the clip's own notes and each voice can stand as the active clip in turn.
 */
async function demoVoices(): Promise<{
  voices: DemoVoice[];
  document: Awaited<ReturnType<typeof makeBwv565Document>>;
}> {
  const document = await makeBwv565Document();
  let nextId = 1;
  const voices = document.tracks.map((track, index) => {
    const clip = track.clips[0];
    const notes: EditorNote[] = clip.notes.map((note) => ({
      id: nextId++,
      pitch: note.pitch,
      velocity: note.velocity,
      startPpq: note.startPpq,
      durationPpq: note.durationPpq,
      channel: note.channel ?? index,
    }));
    const editorTrack = {
      id: index + 1,
      name: track.name,
      color: track.color,
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: index,
    } as unknown as EditorTrack;
    return { track: editorTrack, notes, lengthPpq: clip.lengthPpq };
  });
  return { voices, document };
}

describe('BWV 565 counterpoint verdicts', () => {
  it('reports doubling as texture and keeps the genuine parallels', async () => {
    const { voices, document } = await demoVoices();
    const counts = {
      notes: 0,
      parallelPerfect: 0,
      hiddenParallel: 0,
      voiceCrossing: 0,
      suspension: 0,
      verticalDissonance: 0,
    };
    for (const voice of voices) {
      // Every other voice is context, exactly as the active clip sees them.
      const otherTracks: TrackWithNotes[] = voices
        .filter((other) => other !== voice)
        .map((other) => ({ track: other.track, notes: other.notes }));
      const result = buildGuidance({
        notes: voice.notes,
        clipStartPpq: 0,
        clipLengthPpq: voice.lengthPpq,
        sourceOffsetPpq: 0,
        chordSymbols: [],
        key: NO_KEY,
        timeSignatures: document.timeSignatures,
        otherTracks,
      });
      counts.notes += voice.notes.length;
      for (const analysis of result.byNoteId.values()) {
        const reasons = analysis.safety?.reasons ?? 0;
        if (reasons & ReasonFlag.ParallelPerfect) counts.parallelPerfect++;
        if (reasons & ReasonFlag.HiddenParallel) counts.hiddenParallel++;
        if (reasons & ReasonFlag.VoiceCrossing) counts.voiceCrossing++;
        if (reasons & ReasonFlag.Suspension) counts.suspension++;
        if (reasons & ReasonFlag.VerticalDissonance) counts.verticalDissonance++;
      }
    }

    // The piece doubles its lines at the octave through most of the toccata's
    // opening, which the library reads as 342 parallel octaves. What is left is
    // the handful of places where two lines that were moving independently fall
    // into a perfect interval together.
    expect(counts.notes).toBe(3795);
    expect(counts.parallelPerfect).toBe(11);
    // Everything else is the library's answer untouched.
    expect(counts.hiddenParallel).toBe(83);
    expect(counts.voiceCrossing).toBe(12);
    expect(counts.suspension).toBe(10);
    expect(counts.verticalDissonance).toBe(107);
  });

  it('reads the predicate suite over the whole piece without disturbing the verdicts', async () => {
    const { voices, document } = await demoVoices();
    // The store estimates a key for a document that names none, and the editing
    // surfaces analyse against that estimate; the melodic readings are spelled
    // from it, so the pass has to be run the way the app runs it. D natural
    // minor is what the notes come back as.
    const key = detectScaleHighlightFromTracks(
      voices.map((voice) => ({ track: voice.track, notes: voice.notes })),
    );
    expect(key).toEqual({ enabled: true, rootPc: 2, modeMask: 1453 });
    if (key === null) return;

    const counts = {
      notes: 0,
      forbiddenLeap: 0,
      leadingToneResolution: 0,
      battuta: 0,
      parallelPerfect: 0,
      hiddenParallel: 0,
      voiceCrossing: 0,
      suspension: 0,
      verticalDissonance: 0,
    };
    for (const voice of voices) {
      const otherTracks: TrackWithNotes[] = voices
        .filter((other) => other !== voice)
        .map((other) => ({ track: other.track, notes: other.notes }));
      const result = buildGuidance({
        notes: voice.notes,
        clipStartPpq: 0,
        clipLengthPpq: voice.lengthPpq,
        sourceOffsetPpq: 0,
        chordSymbols: [],
        key,
        timeSignatures: document.timeSignatures,
        otherTracks,
      });
      counts.notes += voice.notes.length;
      for (const analysis of result.byNoteId.values()) {
        const reasons = analysis.safety?.reasons ?? 0;
        if (reasons & ReasonFlag.ParallelPerfect) counts.parallelPerfect++;
        if (reasons & ReasonFlag.HiddenParallel) counts.hiddenParallel++;
        if (reasons & ReasonFlag.VoiceCrossing) counts.voiceCrossing++;
        if (reasons & ReasonFlag.Suspension) counts.suspension++;
        if (reasons & ReasonFlag.VerticalDissonance) counts.verticalDissonance++;
        if (analysis.counterpoint?.forbiddenLeap === true) counts.forbiddenLeap++;
        if (analysis.counterpoint?.leadingToneResolution === true) {
          counts.leadingToneResolution++;
        }
        if (analysis.counterpoint?.battuta === true) counts.battuta++;
      }
    }

    // The toccata's line is full of tritones, sevenths and — once the piece is
    // committed to Bb rather than A# — augmented seconds, so the melodic
    // reading fires on roughly one note in twelve, spread over all four voices.
    // The other two are rare by nature: the leading tone only resolves where the
    // music actually cadences, and the battuta names one specific approach.
    expect(counts.notes).toBe(3795);
    expect(counts.forbiddenLeap).toBe(310);
    expect(counts.leadingToneResolution).toBe(76);
    expect(counts.battuta).toBe(39);
    // Reading them changes nothing the safety verdict already answered: the same
    // four counts the key-free pass above pins, under an estimated key.
    expect(counts.parallelPerfect).toBe(11);
    expect(counts.hiddenParallel).toBe(83);
    expect(counts.voiceCrossing).toBe(12);
    expect(counts.suspension).toBe(10);
    expect(counts.verticalDissonance).toBe(107);
  });
});

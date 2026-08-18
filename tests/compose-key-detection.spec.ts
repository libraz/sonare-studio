/**
 * Proof that a project with no key set gets one read off its own notes.
 *
 * The estimate replaces a hardcoded C major that every theory surface used to
 * measure against silently, so what matters here is both that a real piece is
 * recognized and that music which settles on no tonic is refused rather than
 * answered with a guess.
 */

import { namedScaleMask } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { detectScaleHighlight, detectScaleHighlightFromTracks } from '@/compose/key';
import { makeBwv565Document } from '@/project/demo/bwv565';
import type { EditorNote, EditorTrack } from '@/project/types';

const MINOR_MASKS = [
  namedScaleMask('naturalMinor'),
  namedScaleMask('harmonicMinor'),
  namedScaleMask('melodicMinor'),
];

function event(pitch: number, index: number, durationBeat = 1) {
  return { pitch, startBeat: index, durationBeat, velocity: 96 };
}

function track(partial: Partial<EditorTrack>): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  } as EditorTrack;
}

function note(partial: Partial<EditorNote>): EditorNote {
  return {
    id: 1,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

describe('detectScaleHighlight', () => {
  it('reads D minor off the BWV 565 demo rather than assuming C major', async () => {
    const doc = await makeBwv565Document();
    const detected = detectScaleHighlightFromTracks(
      doc.tracks.map((documentTrack, index) => ({
        track: track({ id: index, name: documentTrack.name }),
        notes: documentTrack.clips.flatMap((clip) =>
          clip.notes.map((clipNote, noteIndex) =>
            note({
              id: index * 100000 + noteIndex,
              pitch: clipNote.pitch,
              velocity: clipNote.velocity,
              startPpq: clip.startPpq + clipNote.startPpq,
              durationPpq: clipNote.durationPpq,
              channel: clipNote.channel,
            }),
          ),
        ),
      })),
    );
    expect(detected).not.toBeNull();
    expect(detected?.enabled).toBe(true);
    expect(detected?.rootPc).toBe(2);
    expect(MINOR_MASKS).toContain(detected?.modeMask);
  });

  it('answers a plain major phrase with its own tonic', () => {
    const phrase = [67, 71, 74, 67, 62, 67, 71, 79].map((pitch, index) => event(pitch, index));
    // The tonic is held longest, which is what the duration weighting reads.
    phrase.push(event(55, phrase.length, 8));
    const detected = detectScaleHighlight(phrase);
    expect(detected).toEqual({ enabled: true, rootPc: 7, modeMask: namedScaleMask('major') });
  });

  it('refuses an estimate when nothing sounds', () => {
    expect(detectScaleHighlight([])).toBeNull();
    expect(detectScaleHighlightFromTracks([])).toBeNull();
    expect(detectScaleHighlightFromTracks([{ track: track({}), notes: [] }])).toBeNull();
  });

  it('refuses an estimate when no tonic stands out', () => {
    // A chromatic run and a whole-tone scale score identically on every tonic:
    // the winner is decided by the tie-break, not by the music, so there is
    // nothing here to report as a key.
    const chromatic = Array.from({ length: 12 }, (_, index) => event(60 + index, index));
    const wholeTone = [60, 62, 64, 66, 68, 70].map((pitch, index) => event(pitch, index));
    expect(detectScaleHighlight(chromatic)).toBeNull();
    expect(detectScaleHighlight(wholeTone)).toBeNull();
  });

  it('ignores notes that never sound', () => {
    const detected = detectScaleHighlightFromTracks([
      {
        track: track({}),
        notes: [
          note({ id: 1, pitch: 60, durationPpq: 0 }),
          note({ id: 2, pitch: 61, startPpq: 1 }),
        ],
      },
    ]);
    // Only the second note sounds, so the estimate is rooted on it.
    expect(detected?.rootPc).toBe(1);
  });

  it('drops percussion tracks before weighing the notes', () => {
    const pitched = {
      track: track({ id: 1, name: 'Organ' }),
      notes: [62, 65, 69, 62, 57, 74].map((pitch, index) =>
        note({ id: index, pitch, startPpq: index, durationPpq: 1 }),
      ),
    };
    // A kit whose note numbers happen to spell a different tonic; on channel 10
    // and named as drums, so it must not weigh on the key at all.
    const drums = {
      track: track({ id: 2, name: 'Drums' }),
      notes: [36, 38, 42, 36, 38, 42, 36, 38].map((pitch, index) =>
        note({ id: 100 + index, pitch, startPpq: index, durationPpq: 1, channel: 9 }),
      ),
    };
    expect(detectScaleHighlightFromTracks([pitched, drums])).toEqual(
      detectScaleHighlightFromTracks([pitched]),
    );
  });
});

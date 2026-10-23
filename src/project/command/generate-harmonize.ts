/**
 * Melody-harmonization command.
 *
 * Takes the active MIDI clip's melody and derives a chord progression for it
 * with libcantus's `harmonizeMelody` (a Viterbi search over diatonic and,
 * optionally, secondary-dominant / borrowed candidates), writing the result to
 * the project chord track.
 *
 * The melody is reduced to a single voice first ({@link topVoiceOnly}): a clip
 * that carries accompaniment chord tones alongside the tune would otherwise
 * skew key inference and let inner voices be scored as melody. Notes are placed
 * on the shared timeline (clip start added) so the returned chord spans land at
 * absolute PPQ positions.
 *
 * When `transpose` is enabled and the search picks a non-zero shift, the clip's
 * notes are transposed to match the harmonization (clamped to the MIDI range)
 * inside the same undoable edit — chord write plus note write, so undo reverts
 * both at once. Without a transpose the chords match the melody as-is and only
 * the chord track changes.
 */

import { type HarmonizeResult, harmonizeMelody, type KeyScale } from '@libraz/libcantus';
import { chordSpanToEditorChord } from '@/compose/chord-io';
import { createGenerationTargetFrame } from '@/compose/generation-target';
import { scaleHighlightToKeyScale } from '@/compose/key';
import { isDrumTrack, percussionNoteTest, topVoiceOnly } from '@/compose/tracks';
import { type EditorChordSymbol, sanitizeChordSymbols } from '../chords';
import type { RawNote } from '../midi-events';
import { audibleMidiProjector, projectMidiClipNoteOccurrences } from '../midi-projection';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import {
  measureRangeAt,
  meterBarLengthPpq,
  timeSignatureAt,
  timeSignatureRanges,
} from '../time-signature';
import { applyProjectChords } from './chords';
import { executeAtomic } from './history';
import { requireEditableClip } from './utils';

/** Reharmonization strength passed through to libcantus. */
export type ReharmonizeStrength = 'diatonic' | 'secondaryDominant' | 'borrowed';

/** Options for {@link harmonizeFromMelodyCommand}. */
export interface HarmonizeFromMelodyParams {
  /**
   * Key context. `'infer'` lets libcantus detect the key from the melody;
   * omitted uses the project key when a scale is set, otherwise `'infer'`.
   */
  key?: KeyScale | 'infer';
  /** Beats per chord segment (default 4 = one chord per 4/4 bar). */
  harmonicRhythm?: number;
  /** Candidate pool strength (default 'diatonic'). */
  reharmonize?: ReharmonizeStrength;
  /**
   * Search transposes/octave-shifts of the melody for a better-fitting
   * placement and applies the chosen shift to the clip (default false, i.e. the
   * melody is left untouched and chords match it as played). A single safe
   * shift is selected for the complete melody before any meter-range analysis.
   */
  transpose?: boolean;
  /** Deterministic tie-break seed (default 0). */
  seed?: number;
}

/**
 * Converts the harmonization's chord path to editor chord symbols over absolute
 * PPQ regions. Each span runs to the next span's start; the last runs to the
 * melody's end.
 */
function spansToChordSymbols(
  result: HarmonizeResult,
  melodyEndBeat: number,
  timelineOffsetPpq: number,
): EditorChordSymbol[] {
  const spans = [...result.chords].sort((a, b) => a.startBeat - b.startBeat);
  return spans.map((span, index) => {
    const startPpq = timelineOffsetPpq + span.startBeat;
    const endPpq =
      timelineOffsetPpq + (index + 1 < spans.length ? spans[index + 1].startBeat : melodyEndBeat);
    return chordSpanToEditorChord(span, startPpq, endPpq);
  });
}

/**
 * Harmonizes the active MIDI clip's melody into the project chord track.
 *
 * @param params Harmonization options (see {@link HarmonizeFromMelodyParams}).
 * @returns The number of chords written, or 0 when the active clip has no notes.
 * @throws Error when there is no active clip or it belongs to a percussion track.
 */
export function harmonizeFromMelodyCommand(params: HarmonizeFromMelodyParams = {}): number {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (clip === null) throw new Error('No active clip to harmonize');
  requireEditableClip(store, clip.id);
  const track = store.tracks.find((entry) => entry.id === clip.trackId);
  if (track !== undefined && isDrumTrack(track, clip.notes)) {
    throw new Error('Cannot harmonize a percussion clip');
  }
  const target = createGenerationTargetFrame({
    startPpq: clip.startPpq,
    endPpq: clip.startPpq + clip.lengthPpq,
    chords: store.chords,
    timeSignatures: store.timeSignatures,
  });
  // Chord slots sit on the project bar grid, so the melody is expressed from
  // the bar containing the clip start rather than from the clip start itself.
  const gridOriginPpq = measureRangeAt(target.timeSignatures, target.startPpq).startPpq;
  const gridShiftPpq = target.startPpq - gridOriginPpq;
  const isPercussion = percussionNoteTest(track, clip.notes);
  const sourceNotes = projectMidiClipNoteOccurrences(clip);
  const melodyNotes = sourceNotes.filter((note) => !isPercussion(note));
  const melody = topVoiceOnly(
    melodyNotes.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startPpq + gridShiftPpq,
      durationBeat: note.durationPpq,
      velocity: note.velocity,
    })),
  );
  if (melody.length === 0) return 0;
  const melodyEndBeat = melody.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeat),
    0,
  );

  const key =
    params.key ??
    (store.scaleHighlight.enabled ? scaleHighlightToKeyScale(store.scaleHighlight) : 'infer');
  const transpose = params.transpose ?? false;
  const meterRanges = timeSignatureRanges(target.timeSignatures, target.startPpq, target.endPpq);
  const shouldSplitForMeter = params.harmonicRhythm === undefined && meterRanges.length > 1;
  const analysisMeter = meterRanges[0] ?? timeSignatureAt(target.timeSignatures, target.startPpq);
  // `undefined` means infer. Keep the first meter range unkeyed so libcantus
  // can infer it, then feed that result into each following range.
  const explicitKey = key === 'infer' ? undefined : key;
  let shift = 0;
  const analysisKey = explicitKey;
  let analysisMelody = melody;
  // Only the notes that fed the melody move with the transpose; drum hits keep their pitch.
  const audibleOccurrences = audibleMidiProjector(clip, { expandLoops: false }).filter(
    (entry) => !isPercussion(entry.note),
  );
  if (transpose) {
    // Meter splits used to perform independent transpose searches. That can
    // make adjacent chord regions analyse different pitches while the clip is
    // either transposed once or not at all. Probe the full target first, then
    // keep one range-safe shift for every subsequent analysis.
    const probe = harmonizeMelody({
      melody,
      ...(explicitKey !== undefined ? { key: explicitKey } : {}),
      harmonicRhythm: params.harmonicRhythm ?? meterBarLengthPpq(analysisMeter),
      ts: { numerator: analysisMeter.numerator, denominator: analysisMeter.denominator },
      reharmonize: params.reharmonize ?? 'diatonic',
      placement: { transposeSearch: true, octaveSearch: true },
      ctx: { seed: params.seed ?? 0 },
    });
    const candidate = probe.transposeSemitones;
    if (
      Number.isInteger(candidate) &&
      audibleOccurrences.every(
        (entry) => entry.note.pitch + candidate >= 0 && entry.note.pitch + candidate <= 127,
      )
    ) {
      shift = candidate;
      if (shift !== 0)
        analysisMelody = melody.map((note) => ({ ...note, pitch: note.pitch + shift }));
    }
  }
  let generated: EditorChordSymbol[];
  if (shouldSplitForMeter) {
    let segmentKey = analysisKey;
    const symbols: EditorChordSymbol[] = [];
    for (const [rangeIndex, range] of meterRanges.entries()) {
      const localStart = (rangeIndex === 0 ? gridOriginPpq : range.startPpq) - gridOriginPpq;
      const localEnd = range.endPpq - gridOriginPpq;
      const segmentMelody = analysisMelody.flatMap((note) => {
        const start = Math.max(note.startBeat, localStart);
        const end = Math.min(note.startBeat + note.durationBeat, localEnd);
        return end > start
          ? [{ ...note, startBeat: start - localStart, durationBeat: end - start }]
          : [];
      });
      if (segmentMelody.length === 0) continue;
      const result = harmonizeMelody({
        melody: segmentMelody,
        ...(segmentKey !== undefined ? { key: segmentKey } : {}),
        harmonicRhythm: meterBarLengthPpq(range),
        ts: { numerator: range.numerator, denominator: range.denominator },
        reharmonize: params.reharmonize ?? 'diatonic',
        placement: { transposeSearch: false, octaveSearch: false },
        ctx: { seed: params.seed ?? 0 },
      });
      segmentKey = explicitKey ?? result.key.scale;
      symbols.push(
        ...spansToChordSymbols(result, localEnd - localStart, gridOriginPpq + localStart).map(
          (chord) => ({
            ...chord,
            startPpq: Math.max(range.startPpq, chord.startPpq),
            endPpq: Math.min(range.endPpq, chord.endPpq),
          }),
        ),
      );
    }
    generated = sanitizeChordSymbols(symbols);
  } else {
    const harmonicRhythm = params.harmonicRhythm ?? meterBarLengthPpq(analysisMeter);
    const result = harmonizeMelody({
      melody: analysisMelody,
      ...(analysisKey !== undefined ? { key: analysisKey } : {}),
      harmonicRhythm,
      ts: { numerator: analysisMeter.numerator, denominator: analysisMeter.denominator },
      reharmonize: params.reharmonize ?? 'diatonic',
      placement: { transposeSearch: false, octaveSearch: false },
      ctx: { seed: params.seed ?? 0 },
    });
    generated = sanitizeChordSymbols(
      spansToChordSymbols(result, melodyEndBeat, gridOriginPpq).map((chord) => ({
        ...chord,
        startPpq: Math.max(target.startPpq, chord.startPpq),
        endPpq: Math.min(target.endPpq, chord.endPpq),
      })),
    );
  }
  const clipEndPpq = target.endPpq;
  const keptChords = store.chords.filter(
    (chord) => chord.endPpq <= clip.startPpq || chord.startPpq >= clipEndPpq,
  );
  const sanitized = sanitizeChordSymbols([...keptChords, ...generated]);
  const project = getProject();

  if (shift === 0) {
    executeAtomic((edit) => applyProjectChords(store, sanitized, edit));
    return generated.length;
  }

  // Transpose the clip to match the harmonization; the shifted notes and the
  // chord write (with its chord-follow re-voicing) share one undoable edit.
  const audibleNoteIds = new Set(audibleOccurrences.map((entry) => entry.sourceIdentity.noteId));
  const shifted: RawNote[] = clip.notes.map(({ id, ...note }) => ({
    ...note,
    pitch: audibleNoteIds.has(id) ? note.pitch + shift : note.pitch,
  }));
  executeAtomic((edit) => {
    edit(1, () => project.setMidiEvents(clip.id, notesToProjectEvents(shifted)));
    applyProjectChords(store, sanitized, edit);
  });
  return generated.length;
}

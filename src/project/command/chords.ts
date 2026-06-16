import { estimateChordSymbols } from '@/notation/chords';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from '../chords';
import { getProject, useProjectStore } from '../store';
import { execute } from './history';
import { requireClip } from './utils';

/** PPQ length of a whole note (one PPQ unit = one quarter note). */
const PPQ_PER_WHOLE_NOTE = 4;

/** Measure length in PPQ at a position, from the active time signature. */
function measureLengthAtPpq(store: ReturnType<typeof useProjectStore>, ppq: number): number {
  let numerator = 4;
  let denominator = 4;
  for (const signature of store.timeSignatures) {
    if (signature.startPpq > ppq) break;
    numerator = signature.numerator;
    denominator = signature.denominator;
  }
  return (numerator * PPQ_PER_WHOLE_NOTE) / denominator;
}

/**
 * Replaces the project's chord-track annotation stream (one undoable entry).
 *
 * The symbols are sanitized (invalid roots / empty regions dropped, sorted by
 * position) and written through `Project.annotateChords`, which persists in
 * the project document and round-trips on save/load.
 *
 * @param symbols New chord-track symbols (absolute PPQ regions).
 */
export function setProjectChords(symbols: ReadonlyArray<EditorChordSymbol>): void {
  const store = useProjectStore();
  const sanitized = sanitizeChordSymbols(symbols);
  const project = getProject();
  execute(1, () => {
    project.annotateChords(toProjectChordSymbols(sanitized));
    store.refresh();
  });
}

/** Clears the project chord track (one undoable entry); no-op when empty. */
export function clearProjectChords(): void {
  const store = useProjectStore();
  if (store.chords.length === 0) return;
  const project = getProject();
  execute(1, () => {
    project.annotateChords([]);
    store.refresh();
  });
}

/**
 * Estimates chord symbols from a MIDI clip's notes and merges them into the
 * chord track (one undoable entry), replacing any existing symbols that start
 * within the clip's region so re-running is idempotent.
 *
 * Estimation is app-side music theory over the clip's notes (see
 * {@link estimateChordSymbols}); it does not call the engine's audio chord
 * detector. The merged stream is persisted through the engine annotation API.
 *
 * @param clipId Editor id of a MIDI clip.
 * @returns The number of chord symbols detected in the clip.
 */
export function detectChordsForClip(clipId: number): number {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  const detected = estimateChordSymbols(clip.notes, {
    clipStartPpq: clip.startPpq,
    clipLengthPpq: clip.lengthPpq,
    measureLengthPpq: measureLengthAtPpq(store, clip.startPpq),
    keyFifths: 0,
  }).map<EditorChordSymbol>((symbol) => {
    const next: EditorChordSymbol = {
      startPpq: symbol.ppq,
      endPpq: symbol.endPpq,
      rootPc: symbol.rootPc ?? 0,
      quality: symbol.quality ?? 0,
    };
    if (symbol.bassPc !== undefined) next.bassPc = symbol.bassPc;
    return next;
  });
  const clipEnd = clip.startPpq + clip.lengthPpq;
  const kept = store.chords.filter(
    (chord) => chord.startPpq < clip.startPpq || chord.startPpq >= clipEnd,
  );
  setProjectChords([...kept, ...detected]);
  return detected.length;
}

import { estimateChordsFromTracks } from '@/compose/estimate-chords';
import { effectiveKeyScale } from '@/compose/key';
import { timeSignatureAtPpq } from '@/compose/meter';
import type { TrackWithNotes } from '@/compose/tracks';
import { ensureWasm } from '@/lib/wasm';
import { estimateChordSymbols } from '@/notation/chords';
import { loadAsset } from '@/persistence/assets';
import { type AudioChordDetector, analyzeAudioClipChords } from '../audio-chords';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from '../chords';
import { getProject, useProjectStore } from '../store';
import { clipKind } from '../types';
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

/** The outcome of an arrangement-wide chord estimation. */
export interface EstimatedChordSummary {
  /** Number of chord symbols written to the chord track. */
  count: number;
  /** One confidence value in [0, 1] per written symbol, in order. */
  confidence: number[];
  /** Names of percussion tracks excluded from the estimate. */
  excludedTrackNames: string[];
}

/** Every track paired with its notes flattened across clips to absolute PPQ. */
function harmonicTrackNotes(store: ReturnType<typeof useProjectStore>): TrackWithNotes[] {
  return store.tracks.map((track) => {
    const clips = store.clipsByTrack.get(track.id) ?? [];
    const notes = clips.flatMap((clip) =>
      clip.notes.map((note) => ({ ...note, startPpq: note.startPpq + clip.startPpq })),
    );
    return { track, notes };
  });
}

/**
 * Infers a chord progression from the whole arrangement's note content and
 * writes it to the chord track (one undoable entry), replacing any existing
 * symbols. Intended for projects with no chord track (e.g. classical scores or
 * imported MIDI): percussion tracks are excluded and the remaining notes are
 * pooled into a per-bar harmonic estimate (see {@link estimateChordsFromTracks}).
 *
 * The estimate is only committed when at least one chord is inferred, so calling
 * it on an empty project is a harmless no-op that leaves the chord track intact.
 *
 * @returns The written chord count, per-chord confidence, and excluded tracks.
 */
export function estimateChordsFromArrangement(): EstimatedChordSummary {
  const store = useProjectStore();
  const tracks = harmonicTrackNotes(store);
  const key = store.scaleHighlight.enabled ? effectiveKeyScale(store.scaleHighlight) : undefined;
  const estimate = estimateChordsFromTracks(tracks, {
    ...(key !== undefined ? { key } : {}),
    ts: timeSignatureAtPpq(store.timeSignatures, 0),
  });
  if (estimate.symbols.length > 0) setProjectChords(estimate.symbols);
  return {
    count: estimate.symbols.length,
    confidence: estimate.confidence,
    excludedTrackNames: estimate.excludedTrackNames,
  };
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

/**
 * Detects chords from an audio clip with libsonare's audio chord detector and
 * merges them into the chord track (one undoable entry), replacing any existing
 * symbols that start within the clip's region so re-running is idempotent.
 *
 * Unlike {@link detectChordsForClip} (MIDI clips, app-side music theory), this
 * loads the clip's audio and runs the engine detector, so it is asynchronous.
 * Resolves to 0 when the wasm detector is unavailable or nothing is detected.
 *
 * @param clipId Editor id of an audio clip.
 * @returns The number of chord symbols detected in the clip.
 */
export async function detectChordsFromAudioClip(clipId: number): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const wasm = (await ensureWasm()) as unknown as { detectChords?: AudioChordDetector };
  if (typeof wasm.detectChords !== 'function') return 0;
  const detected = await analyzeAudioClipChords(
    clip,
    store.tempoBpm,
    {
      loadAudioAsset: loadAsset,
      detectChords: wasm.detectChords,
    },
    store.tempoSegments,
  );
  const current = store.clips.find((entry) => entry.id === clipId);
  if (
    !current ||
    clipKind(current) !== 'audio' ||
    current.assetId !== clip.assetId ||
    current.startPpq !== clip.startPpq ||
    current.lengthPpq !== clip.lengthPpq ||
    current.sourceOffsetPpq !== clip.sourceOffsetPpq
  ) {
    return 0;
  }
  const clipEnd = clip.startPpq + clip.lengthPpq;
  const kept = store.chords.filter(
    (chord) => chord.startPpq < clip.startPpq || chord.startPpq >= clipEnd,
  );
  setProjectChords([...kept, ...detected]);
  return detected.length;
}

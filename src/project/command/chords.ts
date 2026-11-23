import { estimateChordsFromTracks } from '@/compose/estimate-chords';
import { effectiveKeyScale } from '@/compose/key';
import { timeSignatureAtPpq } from '@/compose/meter';
import { melodyPitchClassesInRegion } from '@/compose/reharm';
import {
  harmonicNotes,
  harmonicTracksOnly,
  isDrumTrack,
  isMelodyTrack,
  percussionNoteTest,
  type TrackWithNotes,
  trackMidiNotes,
} from '@/compose/tracks';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { estimateChordSymbols } from '@/notation/chords';
import { loadAsset } from '@/persistence/assets';
import { analyzeAudioClipChords } from '../audio-chords';
import { chordFollowUpdates } from '../chord-follow';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from '../chords';
import {
  midiSourcePpqToTimeline,
  projectMidiClipNoteOccurrences,
  projectMidiNoteOccurrences,
} from '../midi-projection';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { measureGrid, measureRangeAt, meterBarLengthPpq, timeSignatureAt } from '../time-signature';
import { clipKind, type EditorNote, type LeadFollowStashEntry } from '../types';
import { audioAnalysisSourceRevision } from './audio-analysis-source';
import { type AtomicProjectEdit, execute, executeAtomic } from './history';
import { requireClip } from './utils';

const chordAnalysisOperations = new OperationGeneration();

/** Measure length in PPQ at a position, from the active time signature. */
function measureLengthAtPpq(store: ReturnType<typeof useProjectStore>, ppq: number): number {
  return meterBarLengthPpq(timeSignatureAt(store.timeSignatures, ppq));
}

/**
 * Repeats a chord stream from timeline zero until the requested PPQ length.
 *
 * The source span is measured from its first start to its furthest end, so a
 * progression whose first symbol does not start at zero is still a usable
 * pattern. The final symbol is clipped at the requested boundary and all
 * optional chord fields are copied before the returned stream is sanitized.
 */
export function tileChordSymbols(
  symbols: ReadonlyArray<EditorChordSymbol>,
  lengthPpq: number,
): EditorChordSymbol[] {
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) return [];
  const source = sanitizeChordSymbols(symbols);
  if (source.length === 0) return [];
  const sourceStart = source[0]?.startPpq ?? 0;
  const sourceEnd = source.reduce((max, symbol) => Math.max(max, symbol.endPpq), sourceStart);
  const period = sourceEnd - sourceStart;
  if (!(period > 0)) return [];

  const tiled: EditorChordSymbol[] = [];
  for (let offset = 0; offset < lengthPpq; offset += period) {
    for (const symbol of source) {
      const startPpq = offset + symbol.startPpq - sourceStart;
      const endPpq = offset + symbol.endPpq - sourceStart;
      if (startPpq >= lengthPpq || endPpq <= 0) continue;
      tiled.push({
        ...symbol,
        startPpq: Math.max(0, startPpq),
        endPpq: Math.min(lengthPpq, endPpq),
        ...(symbol.extensions !== undefined ? { extensions: [...symbol.extensions] } : {}),
        ...(symbol.omissions !== undefined ? { omissions: [...symbol.omissions] } : {}),
      });
    }
  }
  return sanitizeChordSymbols(tiled);
}

/** Whether two chord streams carry the same regions and chord annotations. */
export function sameChordStream(
  left: ReadonlyArray<EditorChordSymbol>,
  right: ReadonlyArray<EditorChordSymbol>,
): boolean {
  const a = sanitizeChordSymbols(left);
  const b = sanitizeChordSymbols(right);
  if (a.length !== b.length) return false;
  return a.every((symbol, index) => {
    const other = b[index];
    if (other === undefined) return false;
    if (
      symbol.startPpq !== other.startPpq ||
      symbol.endPpq !== other.endPpq ||
      symbol.rootPc !== other.rootPc ||
      symbol.quality !== other.quality ||
      (symbol.bassPc ?? null) !== (other.bassPc ?? null) ||
      symbol.romanNumeral !== other.romanNumeral
    ) {
      return false;
    }
    const extensions = symbol.extensions ?? [];
    const otherExtensions = other.extensions ?? [];
    const omissions = symbol.omissions ?? [];
    const otherOmissions = other.omissions ?? [];
    return (
      extensions.length === otherExtensions.length &&
      extensions.every((value, toneIndex) => value === otherExtensions[toneIndex]) &&
      omissions.length === otherOmissions.length &&
      omissions.every((value, toneIndex) => value === otherOmissions[toneIndex])
    );
  });
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
  const before = store.chords.map((chord) => ({ ...chord }));
  const { clipEdits: followEdits, stashes } = planChordFollowEdits(store, before, sanitized);
  // The annotation encoding has no field for omitted tones, so the symbols just
  // written are handed to the read-back as hints; without them a chord that
  // omits a tone would come back sounding it.
  if (followEdits.length === 0 && stashes.size === 0) {
    execute(1, () => {
      project.annotateChords(toProjectChordSymbols(sanitized));
      store.refresh(undefined, sanitized);
    });
    return;
  }
  executeAtomic((edit) =>
    writeProjectChordPlan(store, sanitized, { clipEdits: followEdits, stashes }, edit),
  );
}

/**
 * Writes a chord stream as one step inside a caller-owned atomic command.
 *
 * Chord-follow note and stash updates are counted as part of the same
 * transaction, so undo restores both the prior annotations and every
 * re-voiced note.
 */
export function applyProjectChords(
  store: ReturnType<typeof useProjectStore>,
  symbols: ReadonlyArray<EditorChordSymbol>,
  edit: AtomicProjectEdit,
): void {
  const sanitized = sanitizeChordSymbols(symbols);
  const before = store.chords.map((chord) => ({ ...chord }));
  const plan = planChordFollowEdits(store, before, sanitized);
  writeProjectChordPlan(store, sanitized, plan, edit);
}

/** One clip's re-voiced note list, ready to write back to the Project. */
interface ChordFollowClipEdit {
  clipId: number;
  notes: EditorNote[];
}

/** Re-voiced clips plus, per track, its re-voiced lead-follow stash. */
interface ChordFollowPlan {
  clipEdits: ChordFollowClipEdit[];
  stashes: Map<number, LeadFollowStashEntry[]>;
}

/** Applies an already-computed chord-follow plan inside the caller's transaction. */
function writeProjectChordPlan(
  store: ReturnType<typeof useProjectStore>,
  sanitized: ReadonlyArray<EditorChordSymbol>,
  plan: ChordFollowPlan,
  edit: AtomicProjectEdit,
): void {
  const project = getProject();
  const { clipEdits, stashes } = plan;
  edit(1, () => project.annotateChords(toProjectChordSymbols(sanitized)));
  for (const clipEdit of clipEdits) {
    edit(1, () => project.setMidiEvents(clipEdit.clipId, notesToProjectEvents(clipEdit.notes)));
  }
  // Parked lead-follow notes move with their track, so they return at the new pitch.
  store.tracks = store.tracks.map((track) => {
    const stash = stashes.get(track.id);
    return stash === undefined || track.leadFollow === undefined
      ? track
      : { ...track, leadFollow: { ...track.leadFollow, stash } };
  });
  // Re-voiced notes keep their editor ids, so selection and score annotations
  // survive the chord change.
  store.refresh(new Map(clipEdits.map((clipEdit) => [clipEdit.clipId, clipEdit.notes])), sanitized);
}

/**
 * Works out how the tracks following the chord track must be re-voiced for a
 * pending chord edit, their parked lead-follow notes included. Percussion
 * tracks and notes, frozen tracks and looping clips are skipped: a looping clip sounds
 * one note under several chord regions, so no single pitch could follow them all.
 */
function planChordFollowEdits(
  store: ReturnType<typeof useProjectStore>,
  before: ReadonlyArray<EditorChordSymbol>,
  after: ReadonlyArray<EditorChordSymbol>,
): ChordFollowPlan {
  const edits: ChordFollowClipEdit[] = [];
  const stashes = new Map<number, LeadFollowStashEntry[]>();
  for (const track of store.tracks) {
    const mode = track.chordFollow;
    if (mode === undefined || track.frozen !== undefined) continue;
    const trackNotes = trackMidiNotes(store.clips, track.id);
    if (isDrumTrack(track, trackNotes)) continue;
    const isPercussion = percussionNoteTest(track, trackNotes);
    for (const clip of store.clips) {
      if (clip.trackId !== track.id || clipKind(clip) !== 'midi') continue;
      if (clip.loopEnabled || clip.notes.length === 0) continue;
      const updates = chordFollowUpdates(
        clip.notes
          .filter((note) => !isPercussion(note))
          .map((note) => ({
            id: note.id,
            pitch: note.pitch,
            timelinePpq: midiSourcePpqToTimeline(clip, note.startPpq),
          })),
        before,
        after,
        mode,
      );
      if (updates.length === 0) continue;
      const pitchById = new Map(updates.map((update) => [update.id, update.pitch]));
      edits.push({
        clipId: clip.id,
        notes: clip.notes.map((note) => ({ ...note, pitch: pitchById.get(note.id) ?? note.pitch })),
      });
    }
    const stash = track.leadFollow?.stash ?? [];
    const stashUpdates = chordFollowUpdates(
      stash.flatMap((entry, index) => {
        const clip = store.clips.find((candidate) => candidate.id === entry.clipId);
        if (clip === undefined || clip.loopEnabled || isPercussion(entry.note)) return [];
        const timelinePpq = midiSourcePpqToTimeline(clip, entry.note.startPpq);
        return [{ id: index, pitch: entry.note.pitch, timelinePpq }];
      }),
      before,
      after,
      mode,
    );
    if (stashUpdates.length > 0) {
      const pitchByIndex = new Map(stashUpdates.map((update) => [update.id, update.pitch]));
      stashes.set(
        track.id,
        stash.map((entry, index) => {
          const pitch = pitchByIndex.get(index);
          return pitch === undefined ? entry : { ...entry, note: { ...entry.note, pitch } };
        }),
      );
    }
  }
  return { clipEdits: edits, stashes };
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
  /** Confidence in [0, 1], keyed by the written chord's start PPQ. */
  confidenceByStartPpq: ReadonlyMap<number, number>;
  /** Names of percussion tracks excluded from the estimate. */
  excludedTrackNames: string[];
}

/** Every track paired with its notes flattened across clips to absolute PPQ. */
function harmonicTrackNotes(store: ReturnType<typeof useProjectStore>): TrackWithNotes[] {
  return store.tracks.map((track) => {
    const clips = store.clipsByTrack.get(track.id) ?? [];
    const notes = clips.flatMap(projectMidiNoteOccurrences);
    return { track, notes };
  });
}

/**
 * Melody (top-voice) pitch classes sounding within a timeline PPQ region.
 * Explicitly named melody tracks take precedence; otherwise the active MIDI
 * clip is the only source. This avoids treating accompaniment voicings across
 * every harmonic track as mandatory melody tones.
 *
 * @param startPpq Region start (inclusive), absolute timeline PPQ.
 * @param endPpq Region end (exclusive), absolute timeline PPQ.
 * @returns Distinct melody pitch classes, or [] when nothing overlaps.
 */
export function arrangementMelodyPitchClasses(startPpq: number, endPpq: number): number[] {
  const store = useProjectStore();
  const { harmonic } = harmonicTracksOnly(harmonicTrackNotes(store));
  const namedMelody = harmonic.filter((item) => isMelodyTrack(item.track));
  const active = store.activeClip;
  const activeTrack = active
    ? store.tracks.find((track) => track.id === active.trackId)
    : undefined;
  const activeNotes =
    active && clipKind(active) === 'midi' ? projectMidiNoteOccurrences(active) : [];
  const notes =
    namedMelody.length > 0
      ? namedMelody.flatMap((item) => item.notes)
      : activeTrack === undefined
        ? activeNotes
        : isDrumTrack(activeTrack, activeNotes)
          ? []
          : harmonicNotes(activeTrack, activeNotes);
  return melodyPitchClassesInRegion(notes, startPpq, endPpq, 1e-6, {
    ts: timeSignatureAtPpq(store.timeSignatures, startPpq),
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
    timeSignatures: store.timeSignatures,
  });
  if (estimate.symbols.length > 0) setProjectChords(estimate.symbols);
  const confidenceByStartPpq = new Map<number, number>();
  estimate.symbols.forEach((symbol, index) => {
    const confidence = estimate.confidence[index];
    if (confidence !== undefined) confidenceByStartPpq.set(symbol.startPpq, confidence);
  });
  return {
    count: estimate.symbols.length,
    confidenceByStartPpq,
    excludedTrackNames: estimate.excludedTrackNames,
  };
}

/**
 * Estimates chord symbols from a MIDI clip's notes and merges them into the
 * chord track (one undoable entry), replacing any existing symbols that start
 * within the clip's region so re-running is idempotent.
 *
 * Estimation is app-side music theory over the clip's notes (see
 * {@link estimateChordSymbols}, which shares the chord track's libcantus
 * detector); it does not call the engine's audio chord detector. The merged
 * stream is persisted through the engine annotation API.
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
  const clipEnd = clip.startPpq + clip.lengthPpq;
  const notes = projectMidiClipNoteOccurrences(clip);
  // Percussion clips carry drum hits, not harmony; pooling them into chord
  // estimation yields nonsense symbols, so a drum clip detects nothing (the
  // arrangement-wide estimate excludes the same tracks via harmonicTracksOnly).
  const track = store.tracks.find((entry) => entry.id === clip.trackId);
  if (track && isDrumTrack(track, notes)) return 0;
  const detected = estimateChordSymbols(track ? harmonicNotes(track, notes) : notes, {
    clipStartPpq: clip.startPpq,
    clipLengthPpq: clip.lengthPpq,
    measureLengthPpq: measureLengthAtPpq(store, clip.startPpq),
    measures: measureGrid(
      store.timeSignatures,
      measureRangeAt(store.timeSignatures, clip.startPpq).startPpq,
      clipEnd,
    ),
    keyFifths: 0,
  }).map<EditorChordSymbol>((symbol) => {
    const next: EditorChordSymbol = {
      startPpq: symbol.ppq,
      endPpq: symbol.endPpq,
      rootPc: symbol.rootPc ?? 0,
      quality: symbol.quality ?? 0,
    };
    if (symbol.bassPc !== undefined) next.bassPc = symbol.bassPc;
    if (symbol.extensions !== undefined) next.extensions = symbol.extensions;
    return next;
  });
  const kept = store.chords.filter(
    (chord) => chord.endPpq <= clip.startPpq || chord.startPpq >= clipEnd,
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
 * @param signal Aborts the detection; it then rejects with an AbortError and merges nothing.
 * @returns The number of chord symbols detected in the clip.
 */
export async function detectChordsFromAudioClip(
  clipId: number,
  signal?: AbortSignal,
): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const targetId = `chords:${clipId}`;
  const operation = beginProjectOperation(
    chordAnalysisOperations,
    store,
    targetId,
    audioAnalysisSourceRevision(store, clipId),
  );
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(
      chordAnalysisOperations,
      operation,
      store,
      targetId,
      audioAnalysisSourceRevision(store, clipId),
    );
  try {
    const wasm = await ensureWasm();
    signal?.throwIfAborted();
    assertCurrent();
    const detected = await analyzeAudioClipChords(
      clip,
      store.tempoBpm,
      {
        loadAudioAsset: loadAsset,
        detectChords: wasm.detectChords,
      },
      store.tempoSegments,
    );
    signal?.throwIfAborted();
    assertCurrent();
    const clipEnd = clip.startPpq + clip.lengthPpq;
    const kept = store.chords.filter(
      (chord) => chord.endPpq <= clip.startPpq || chord.startPpq >= clipEnd,
    );
    setProjectChords([...kept, ...detected]);
    return detected.length;
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return 0;
    throw error;
  } finally {
    if (chordAnalysisOperations.isCurrent(operation.token)) {
      chordAnalysisOperations.invalidate();
    }
  }
}

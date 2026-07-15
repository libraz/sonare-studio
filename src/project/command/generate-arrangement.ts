/**
 * Full-arrangement generation command.
 *
 * Composes several generators — chord progression, drums, bass, and backing —
 * into a single undoable transaction, so one action lays down a starter
 * arrangement and one undo removes all of it. Parts are opt-in; the bass and
 * backing follow whichever chord track is in play (a freshly generated
 * progression when `progression` is requested, otherwise the existing one).
 *
 * All new material lands on fresh tracks (non-destructive); the progression
 * replaces the project chord track. Every part is deterministic in its seed.
 */

import {
  generateBassLine,
  generateDrums,
  generateProgression,
  voiceProgression,
} from '@libraz/libcantus';
import { chordSpanToEditorChord, editorChordToChord } from '@/compose/chord-io';
import { effectiveKeyScale } from '@/compose/key';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from '../chords';
import type { RawNote } from '../midi-events';
import { getProject, useProjectStore } from '../store';
import { isFourFourBarRange } from '../time-signature';
import { addGeneratedTrack, EDITS_PER_TRACK, materializeNote } from './generate-track';
import { execute } from './history';

/** GM percussion channel (MIDI channel 10, zero-based). */
const GM_PERCUSSION_CHANNEL = 9;

/** Beats per bar the generators assume (4/4). */
const BEATS_PER_BAR = 4;

/** Note-on velocity for backing voicings. */
const BACKING_VELOCITY = 72;

/** NativeSynth presets per generated part, matching the single-shot generators. */
const PART_PRESET = {
  drums: 'drum-kit',
  bass: 'sub-bass',
  backing: 'warm-pad',
} as const;

/** Options for {@link generateArrangementCommand}. */
export interface GenerateArrangementParams {
  /** Number of four-beat bars (default 4). */
  bars?: number;
  /** Generate and place a chord progression, replacing the chord track (default true). */
  progression?: boolean;
  /** Progression style when generating one (default 'idol'). */
  progressionStyle?: Parameters<typeof generateProgression>[0]['style'];
  /** Add a drum track (default true). */
  drums?: boolean;
  /** Add a bass track (default true). */
  bass?: boolean;
  /** Add a backing (chord voicing) track (default true). */
  backing?: boolean;
  /** Deterministic seed shared by the parts (default 0). */
  seed?: number;
}

/** A part's notes destined for a new track. */
interface TrackPlan {
  name: string;
  notes: RawNote[];
  lengthPpq: number;
  preset: string;
}

function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

/** Builds the chord regions to arrange over, generating a progression when asked. */
function resolveChords(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateArrangementParams,
  bars: number,
): { regions: EditorChordSymbol[]; generated: EditorChordSymbol[] | null } {
  if (params.progression === false) {
    const endPpq = bars * BEATS_PER_BAR;
    const regions = store.chords
      .filter((chord) => chord.startPpq < endPpq && chord.endPpq > 0)
      .map((chord) => ({
        ...chord,
        startPpq: Math.max(0, chord.startPpq),
        endPpq: Math.min(endPpq, chord.endPpq),
      }))
      .filter((chord) => chord.endPpq > chord.startPpq)
      .sort((a, b) => a.startPpq - b.startPpq);
    return { regions, generated: null };
  }
  const key = effectiveKeyScale(store.scaleHighlight);
  const spans = generateProgression({
    key,
    style: params.progressionStyle ?? 'idol',
    bars,
    seed: params.seed ?? 0,
  });
  const regions = spans.map((span, index) => {
    const start = span.startBeat;
    const end = index + 1 < spans.length ? spans[index + 1].startBeat : bars * BEATS_PER_BAR;
    return chordSpanToEditorChord(span, start, end);
  });
  return { regions, generated: regions };
}

/**
 * Generates a starter arrangement in one undoable transaction.
 *
 * @param params Which parts to generate and their options.
 * @returns The number of tracks created.
 * @throws RangeError when `bars` is not a positive integer; propagates
 *   voicing-range errors from the backing part.
 */
export function generateArrangementCommand(params: GenerateArrangementParams = {}): number {
  const store = useProjectStore();
  const bars = params.bars ?? 4;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(`Arrangement bars must be a positive integer, got ${bars}`);
  }
  if (!isFourFourBarRange(store.timeSignatures, 0, bars)) {
    throw new RangeError('Arrangement generation currently supports 4/4 bars only.');
  }
  const seed = params.seed ?? 0;
  const { regions, generated } = resolveChords(store, params, bars);
  const barsLength = bars * BEATS_PER_BAR;

  const plans: TrackPlan[] = [];

  if (params.drums !== false) {
    const hits = generateDrums({
      bars,
      bpm: store.tempoBpm,
      style: 'standard',
      section: 'verse',
      density: 0.6,
      seed,
    });
    const notes = noteEventsToNewEditorNotes(hits, { channel: GM_PERCUSSION_CHANNEL }).map(
      materializeNote,
    );
    if (notes.length > 0) {
      plans.push({ name: 'Drums', notes, lengthPpq: barsLength, preset: PART_PRESET.drums });
    }
  }

  if (params.bass !== false && regions.length > 0) {
    const key = effectiveKeyScale(store.scaleHighlight);
    const events = generateBassLine({
      segments: regions.map((region) => ({
        startBeat: region.startPpq,
        endBeat: region.endPpq,
        chord: editorChordToChord(region),
      })),
      key,
      seed,
    });
    const notes = noteEventsToNewEditorNotes(events, { channel: 0 }).map(materializeNote);
    const lengthPpq = regions.reduce((max, region) => Math.max(max, region.endPpq), 0);
    if (notes.length > 0) plans.push({ name: 'Bass', notes, lengthPpq, preset: PART_PRESET.bass });
  }

  if (params.backing !== false && regions.length > 0) {
    const voicings = voiceProgression(regions.map(editorChordToChord));
    const notes: RawNote[] = [];
    regions.forEach((region, index) => {
      const duration = region.endPpq - region.startPpq;
      if (duration <= 0) return;
      for (const pitch of voicings[index] ?? []) {
        notes.push({
          pitch: clampPitch(pitch),
          startPpq: region.startPpq,
          durationPpq: duration,
          velocity: BACKING_VELOCITY,
          channel: 0,
        });
      }
    });
    const lengthPpq = regions.reduce((max, region) => Math.max(max, region.endPpq), 0);
    if (notes.length > 0) {
      plans.push({ name: 'Backing', notes, lengthPpq, preset: PART_PRESET.backing });
    }
  }

  const chordEdits = generated !== null ? 1 : 0;
  const totalEdits = chordEdits + EDITS_PER_TRACK * plans.length;
  if (totalEdits === 0) return 0;

  const project = getProject();
  const sanitizedChords = generated !== null ? sanitizeChordSymbols(generated) : null;
  execute(totalEdits, () => {
    if (sanitizedChords !== null) {
      project.annotateChords(toProjectChordSymbols(sanitizedChords));
    }
    for (const plan of plans) {
      addGeneratedTrack(store, {
        name: plan.name,
        notes: plan.notes,
        startPpq: 0,
        lengthPpq: plan.lengthPpq,
        preset: plan.preset,
      });
    }
    if (plans.length === 0) store.refresh();
  });
  return plans.length;
}

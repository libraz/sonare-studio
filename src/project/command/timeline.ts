import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { type AudioSectionAnalyzer, analyzeAudioClipSections } from '../audio-sections';
import { allocateMarkerId, allocateSectionId, getProject, useProjectStore } from '../store';
import {
  clipKind,
  DEFAULT_SECTION_COLOR,
  type TempoSegment,
  type TimeSignatureSegment,
} from '../types';
import { execute } from './history';
import { requireClip, validatePpq } from './utils';

/**
 * Adds or updates a timeline marker as one undoable edit. Markers are
 * app-level metadata: the Project's setMarker has no matching removal or
 * listing API, so the mirror is authoritative and the Project is not written.
 *
 * @param markerId Id of the marker to update, or null/0 to create one.
 * @param ppq Marker position in PPQ (>= 0).
 * @param name Marker display name.
 * @returns The stable marker id (the new id when one was created).
 */
export function setMarker(markerId: number | null, ppq: number, name: string): number {
  const store = useProjectStore();
  validatePpq(ppq, 'Marker ppq');
  if (markerId !== null && markerId !== 0) {
    const existing = store.markers.find((m) => m.id === markerId);
    if (!existing) throw new RangeError(`Unknown marker id: ${markerId}`);
    // Re-confirming a marker with unchanged fields must not consume an undo
    // slot (or discard the redo stack).
    if (existing.ppq === ppq && existing.name === name) return markerId;
  }
  return execute(0, () => {
    if (markerId === null || markerId === 0) {
      const id = allocateMarkerId();
      store.markers = [...store.markers, { id, ppq, name }].sort(
        (a, b) => a.ppq - b.ppq || a.id - b.id,
      );
      store.refresh();
      return id;
    }
    store.markers = store.markers
      .map((m) => (m.id === markerId ? { ...m, ppq, name } : m))
      .sort((a, b) => a.ppq - b.ppq || a.id - b.id);
    store.refresh();
    return markerId;
  });
}

/**
 * Removes a timeline marker as one undoable edit. Unknown ids are a no-op.
 *
 * @param markerId Id of the marker to remove.
 */
export function removeMarker(markerId: number): void {
  const store = useProjectStore();
  if (!store.markers.some((m) => m.id === markerId)) return;
  execute(0, () => {
    store.markers = store.markers.filter((m) => m.id !== markerId);
    store.refresh();
  });
}

/** Input shape for {@link setSections}; ids are preserved when provided. */
export interface SectionInput {
  /** Existing section id to preserve; omitted = a new id is allocated. */
  id?: number;
  /** Section display name. */
  name: string;
  /** Display color; defaults to the shared section color. */
  color?: string;
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/**
 * Replaces the section list as one undoable edit. Sections are app-level
 * metadata (the Project has no section API); the list is kept sorted by
 * start position.
 *
 * @param sections New section list; entries with an id keep it.
 */
export function setSections(sections: ReadonlyArray<SectionInput>): void {
  const store = useProjectStore();
  for (const section of sections) {
    validatePpq(section.startPpq, 'Section startPpq');
    if (!Number.isFinite(section.endPpq) || section.endPpq <= section.startPpq) {
      throw new RangeError(
        `Section endPpq must be > startPpq, got [${section.startPpq}, ${section.endPpq}]`,
      );
    }
  }
  execute(0, () => {
    store.sections = sections
      .map((section) => ({
        id: section.id ?? allocateSectionId(),
        name: section.name,
        color: section.color ?? DEFAULT_SECTION_COLOR,
        startPpq: section.startPpq,
        endPpq: section.endPpq,
      }))
      .sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq || a.id - b.id);
    store.refresh();
  });
}

/**
 * Detects song sections from an audio clip with libsonare's `analyzeSections`
 * and merges them into the section list (one undoable edit), replacing any
 * existing sections that start within the clip's region so re-running is
 * idempotent. Resolves to 0 when the analyzer is unavailable or nothing is
 * detected.
 *
 * @param clipId Editor id of an audio clip.
 * @returns The number of sections detected in the clip.
 */
export async function detectSectionsFromAudioClip(clipId: number): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const wasm = (await ensureWasm()) as unknown as { analyzeSections?: AudioSectionAnalyzer };
  if (typeof wasm.analyzeSections !== 'function') return 0;
  const detected = await analyzeAudioClipSections(clip, store.tempoBpm, {
    loadAudioAsset: loadAsset,
    analyzeSections: wasm.analyzeSections,
  });
  const clipEnd = clip.startPpq + clip.lengthPpq;
  const kept = store.sections.filter(
    (section) => section.startPpq < clip.startPpq || section.startPpq >= clipEnd,
  );
  setSections([...kept, ...detected]);
  return detected.length;
}

/**
 * Replaces the project's tempo map as one undoable edit (delegates to
 * Project.setTempoSegments).
 *
 * @param segments Non-empty tempo segments sorted by ascending startPpq.
 */
export function setTempoSegments(segments: ReadonlyArray<TempoSegment>): void {
  const store = useProjectStore();
  const project = getProject();
  if (segments.length === 0) throw new RangeError('Tempo map must contain at least one segment');
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Tempo segment startPpq');
    if (!Number.isFinite(segment.bpm) || segment.bpm <= 0) {
      throw new RangeError(`Tempo bpm must be finite and > 0, got ${segment.bpm}`);
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Tempo segments must have strictly ascending startPpq');
    }
  });
  execute(1, () => {
    project.setTempoSegments(
      segments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
    );
    store.refresh();
  });
}

/**
 * Replaces the project's time-signature map as one undoable edit (delegates
 * to Project.setTimeSignatures).
 *
 * @param segments Non-empty meter segments sorted by ascending startPpq.
 */
export function setTimeSignatures(segments: ReadonlyArray<TimeSignatureSegment>): void {
  const store = useProjectStore();
  const project = getProject();
  if (segments.length === 0) {
    throw new RangeError('Time-signature map must contain at least one segment');
  }
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Time-signature startPpq');
    if (!Number.isInteger(segment.numerator) || segment.numerator < 1) {
      throw new RangeError('Time-signature numerator must be a positive integer');
    }
    if (!Number.isInteger(segment.denominator) || segment.denominator < 1) {
      throw new RangeError('Time-signature denominator must be a positive integer');
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Time-signature segments must have strictly ascending startPpq');
    }
  });
  execute(1, () => {
    project.setTimeSignatures(segments.map((s) => ({ ...s })));
    store.refresh();
  });
}

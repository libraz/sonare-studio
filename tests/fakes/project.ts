/**
 * Complete project fixtures with overrides. A spec states only the fields it
 * drives; the rest take neutral defaults, so a field the model gains is added
 * here once instead of failing the type check in every spec.
 */

import type { DocumentClip } from '@/project/document-schema';
import type { EditorClip, EditorTrack } from '@/project/types';

/** An unmuted, unsoloed MIDI track at unity gain and center pan. */
export function editorTrack(overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#888888',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...overrides,
  };
}

/** An empty, unlooped one-bar clip on track 1. */
export function editorClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    ...overrides,
  };
}

/** An empty, unlooped one-bar document clip. */
export function documentClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    ...overrides,
  };
}

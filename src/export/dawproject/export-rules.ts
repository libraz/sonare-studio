/**
 * Predicates the DAWproject exporter and its loss inspector must agree on, so
 * what the dialog reports as dropped is exactly what the writer drops.
 */

import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentTrack,
  ProjectDocument,
} from '@/project/serialization';

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Returns a CSS color when it is hex-formatted (the format DAWproject uses). */
export function hexColor(color: string): string | undefined {
  return HEX_COLOR.test(color) ? color : undefined;
}

/** A group track has no pan of its own in the written project, so its pan lane is dropped. */
export function isGroupPanAutomation(
  trackKind: DocumentTrack['kind'],
  lane: DocumentAutomationLane,
): boolean {
  return trackKind === 'group' && lane.param === 'pan';
}

/** The warp written as a standard Warps mapping, or null when the clip is exported unwarped. */
export function exportedWarp(clip: DocumentClip): NonNullable<DocumentClip['warp']> | null {
  const warp = clip.warp;
  return warp?.enabled === true && warp.sourceBpm > 0 ? warp : null;
}

/** Per-member dB offset of each VCA group, keyed by group id. */
export function vcaGainDbByGroupId(doc: ProjectDocument): Map<string, number> {
  return new Map((doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group.gainDb]));
}

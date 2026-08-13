import { annotationsFromDocument, type ScoreAnnotations } from './annotations';
import { sanitizeCompSegments } from './comping';
import {
  isValidChannel,
  isValidController,
  sanitizeCcPoints,
  sanitizePitchBendPoints,
  sanitizePressurePoints,
} from './midi-cc';
import type { DocumentClip } from './serialization';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipKind,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  EditorClip,
  MidiClipTake,
  SmfSysExPacket,
} from './types';
import { sanitizeClipWarp } from './warp';

/**
 * Applies document-only clip metadata onto the refreshed clip mirror.
 *
 * Clip names, kinds and asset references are app metadata the Project does not
 * store, so they are merged in after {@link refresh} built the clip mirror.
 * CC / pitch-bend / pressure lanes are re-sanitized against the clip window;
 * malformed lanes and points drop out.
 *
 * @param clips Clip mirror built by refresh from the rebuilt Project.
 * @param clipMeta Document clip metadata keyed by the rebuilt clip id.
 * @returns A new clip array with the metadata applied.
 */
export function applyDocumentClipMetadata(
  clips: ReadonlyArray<EditorClip>,
  clipMeta: Map<number, DocumentClip>,
): EditorClip[] {
  return clips.map((clip) => {
    const meta = clipMeta.get(clip.id);
    if (!meta) return clip;
    const next: EditorClip = { ...clip, name: meta.name };
    const kind: ClipKind = meta.kind === 'audio' ? 'audio' : 'midi';
    if (kind === 'audio') {
      next.kind = 'audio';
      if (meta.assetId !== undefined) next.assetId = meta.assetId;
      if ((meta.fadeInPpq ?? 0) > 0) next.fadeInPpq = meta.fadeInPpq as number;
      if ((meta.fadeOutPpq ?? 0) > 0) next.fadeOutPpq = meta.fadeOutPpq as number;
      // Takes/comping are document metadata; malformed selections are
      // re-sanitized on expansion (src/project/comping.ts).
      if (Array.isArray(meta.takes) && meta.takes.length > 0) {
        next.takes = meta.takes
          .filter((take) => typeof take?.assetId === 'string' && take.assetId.length > 0)
          .map((take) => ({ assetId: take.assetId, name: String(take.name ?? '') }));
        if (next.takes.length === 0) {
          delete next.takes;
        } else if (Array.isArray(meta.compSegments) && meta.compSegments.length > 0) {
          next.compSegments = sanitizeCompSegments(
            meta.compSegments.map((segment) => ({
              startPpq: Number(segment.startPpq),
              takeIndex: Number(segment.takeIndex),
              ...(Number.isFinite(segment.crossfadePpq)
                ? { crossfadePpq: Number(segment.crossfadePpq) }
                : {}),
            })),
            next.takes.length,
            clip.lengthPpq,
          );
          if (next.compSegments.length === 0) delete next.compSegments;
        }
      }
      if (
        meta.warp !== undefined &&
        typeof meta.warp.enabled === 'boolean' &&
        Number.isFinite(meta.warp.sourceBpm) &&
        meta.warp.sourceBpm > 0
      ) {
        next.warp = sanitizeClipWarp(
          {
            enabled: meta.warp.enabled,
            sourceBpm: meta.warp.sourceBpm,
            ...(Number.isFinite(meta.warp.sourceStartSeconds)
              ? { sourceStartSeconds: Number(meta.warp.sourceStartSeconds) }
              : {}),
            ...(Number.isFinite(meta.warp.sourceEndSeconds)
              ? { sourceEndSeconds: Number(meta.warp.sourceEndSeconds) }
              : {}),
            ...(Array.isArray(meta.warp.anchors)
              ? {
                  anchors: meta.warp.anchors.map((anchor) => ({
                    ppq: Number(anchor.ppq),
                    sourceSeconds: Number(anchor.sourceSeconds),
                  })),
                }
              : {}),
          },
          clip.lengthPpq,
        );
      }
    }
    if (kind === 'midi' && Array.isArray(meta.midiTakes) && meta.midiTakes.length > 0) {
      const takes: MidiClipTake[] = [];
      for (const take of meta.midiTakes) {
        if (typeof take?.name !== 'string' || !Array.isArray(take.notes)) continue;
        const notes = take.notes
          .map((note) => ({
            pitch: Math.round(Number(note.pitch)),
            velocity: Math.round(Number(note.velocity)),
            startPpq: Number(note.startPpq),
            durationPpq: Number(note.durationPpq),
            channel: Math.round(Number(note.channel)),
            ...(Number.isFinite(note.offVelocity)
              ? { offVelocity: Math.round(Number(note.offVelocity)) }
              : {}),
          }))
          .filter(
            (note) =>
              Number.isInteger(note.pitch) &&
              note.pitch >= 0 &&
              note.pitch <= 127 &&
              Number.isInteger(note.velocity) &&
              note.velocity >= 1 &&
              note.velocity <= 127 &&
              Number.isFinite(note.startPpq) &&
              note.startPpq >= 0 &&
              Number.isFinite(note.durationPpq) &&
              note.durationPpq > 0 &&
              isValidChannel(note.channel) &&
              (note.offVelocity === undefined ||
                (Number.isInteger(note.offVelocity) &&
                  note.offVelocity >= 1 &&
                  note.offVelocity <= 127)),
          );
        takes.push({
          name: take.name,
          notes,
          ...(take.ccLanes !== undefined
            ? {
                ccLanes: take.ccLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.pitchBendLanes !== undefined
            ? {
                pitchBendLanes: take.pitchBendLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.programChangeLanes !== undefined
            ? {
                programChangeLanes: take.programChangeLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.channelPressureLanes !== undefined
            ? {
                channelPressureLanes: take.channelPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.polyPressureLanes !== undefined
            ? {
                polyPressureLanes: take.polyPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
        });
      }
      if (takes.length > 0) {
        next.midiTakes = takes;
        next.midiActiveTakeIndex = Math.min(
          Math.max(0, Math.floor(Number(meta.midiActiveTakeIndex) || 0)),
          takes.length - 1,
        );
        if (Array.isArray(meta.midiCompSegments) && meta.midiCompSegments.length > 0) {
          next.midiCompSegments = sanitizeCompSegments(
            meta.midiCompSegments.map((segment) => ({
              startPpq: Number(segment.startPpq),
              takeIndex: Number(segment.takeIndex),
            })),
            takes.length,
            clip.lengthPpq,
          );
        }
      }
    }
    // CC lanes are MIDI-clip metadata; hydrate and re-sanitize them against
    // the clip window (malformed lanes/points drop out).
    if (kind === 'midi' && Array.isArray(meta.ccLanes) && meta.ccLanes.length > 0) {
      const lanes: ClipCcLane[] = [];
      for (const lane of meta.ccLanes) {
        if (!isValidController(lane.controller) || !isValidChannel(lane.channel)) continue;
        const points = sanitizeCcPoints(
          Array.isArray(lane.points) ? lane.points : [],
          clip.lengthPpq,
        );
        if (points.length > 0) {
          lanes.push({ controller: lane.controller, channel: lane.channel, points });
        }
      }
      if (lanes.length > 0) {
        lanes.sort((a, b) => a.controller - b.controller);
        next.ccLanes = lanes;
      }
    }
    if (kind === 'midi' && Array.isArray(meta.pitchBendLanes) && meta.pitchBendLanes.length > 0) {
      const lanes: ClipPitchBendLane[] = [];
      for (const lane of meta.pitchBendLanes) {
        if (!isValidChannel(lane.channel)) continue;
        const points = sanitizePitchBendPoints(
          Array.isArray(lane.points) ? lane.points : [],
          clip.lengthPpq,
        );
        if (points.length > 0) lanes.push({ channel: lane.channel, points });
      }
      if (lanes.length > 0) {
        lanes.sort((a, b) => a.channel - b.channel);
        next.pitchBendLanes = lanes;
      }
    }
    if (
      kind === 'midi' &&
      Array.isArray(meta.programChangeLanes) &&
      meta.programChangeLanes.length > 0
    ) {
      const lanes: ClipProgramChangeLane[] = [];
      for (const lane of meta.programChangeLanes) {
        if (!isValidChannel(lane.channel)) continue;
        const points = (Array.isArray(lane.points) ? lane.points : [])
          .map((point) => ({
            ppq: Number(point.ppq),
            program: Math.round(Number(point.program)),
          }))
          .filter(
            (point) =>
              Number.isFinite(point.ppq) &&
              point.ppq >= 0 &&
              point.ppq <= clip.lengthPpq &&
              Number.isInteger(point.program) &&
              point.program >= 0 &&
              point.program <= 127,
          )
          .sort((a, b) => a.ppq - b.ppq);
        if (points.length > 0) lanes.push({ channel: lane.channel, points });
      }
      if (lanes.length > 0) {
        lanes.sort((a, b) => a.channel - b.channel);
        next.programChangeLanes = lanes;
      }
    }
    if (
      kind === 'midi' &&
      Array.isArray(meta.channelPressureLanes) &&
      meta.channelPressureLanes.length > 0
    ) {
      const lanes: ClipChannelPressureLane[] = [];
      for (const lane of meta.channelPressureLanes) {
        if (!isValidChannel(lane.channel)) continue;
        const points = sanitizePressurePoints(
          Array.isArray(lane.points) ? lane.points : [],
          clip.lengthPpq,
        );
        if (points.length > 0) lanes.push({ channel: lane.channel, points });
      }
      if (lanes.length > 0) {
        lanes.sort((a, b) => a.channel - b.channel);
        next.channelPressureLanes = lanes;
      }
    }
    if (
      kind === 'midi' &&
      Array.isArray(meta.polyPressureLanes) &&
      meta.polyPressureLanes.length > 0
    ) {
      const lanes: ClipPolyPressureLane[] = [];
      for (const lane of meta.polyPressureLanes) {
        if (!isValidChannel(lane.channel)) continue;
        const pitch = Math.round(Number(lane.pitch));
        if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) continue;
        const points = sanitizePressurePoints(
          Array.isArray(lane.points) ? lane.points : [],
          clip.lengthPpq,
        );
        if (points.length > 0) lanes.push({ channel: lane.channel, pitch, points });
      }
      if (lanes.length > 0) {
        lanes.sort((a, b) => a.channel - b.channel || a.pitch - b.pitch);
        next.polyPressureLanes = lanes;
      }
    }
    if (kind === 'midi' && Array.isArray(meta.smfSysEx) && meta.smfSysEx.length > 0) {
      const packets: SmfSysExPacket[] = [];
      let totalBytes = 0;
      for (const packet of meta.smfSysEx) {
        if (
          !Number.isFinite(packet.ppq) ||
          packet.ppq < 0 ||
          (packet.status !== 0xf0 && packet.status !== 0xf7) ||
          !Array.isArray(packet.data) ||
          packet.data.length > 0x0fffffff
        )
          continue;
        const data = packet.data.map((byte) => Math.round(Number(byte)));
        if (data.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) continue;
        totalBytes += data.length;
        if (packets.length >= 4096 || totalBytes > 1024 * 1024) break;
        packets.push({ ppq: packet.ppq, status: packet.status, data });
      }
      if (packets.length > 0) next.smfSysEx = packets;
    }
    return next;
  });
}

/**
 * Re-associates content-addressed document score annotations onto the freshly
 * assigned editor note ids, keyed by clip id.
 *
 * @param clips Clip mirror after metadata application.
 * @param clipMeta Document clip metadata keyed by clip id.
 * @returns Score annotations keyed by clip id then editor note id.
 */
export function restoreDocumentScoreAnnotations(
  clips: ReadonlyArray<EditorClip>,
  clipMeta: Map<number, DocumentClip>,
): ScoreAnnotations {
  const nextAnnotations: ScoreAnnotations = {};
  for (const clip of clips) {
    const meta = clipMeta.get(clip.id);
    if (!meta?.scoreAnnotations || meta.scoreAnnotations.length === 0) continue;
    const byNote = annotationsFromDocument(meta.scoreAnnotations, clip.notes);
    if (Object.keys(byNote).length > 0) nextAnnotations[clip.id] = byNote;
  }
  return nextAnnotations;
}

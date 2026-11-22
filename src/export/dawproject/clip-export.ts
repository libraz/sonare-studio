/** Writes one arrangement clip: MIDI notes, or an audio file reference with its warp. */

import { clamp01 } from '@/lib/math';
import type { DocumentClip } from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import { sanitizeWarpAnchors } from '@/project/warp';
import { audioContentOriginPpq, audioContentPpqToSeconds } from './audio-time';
import { exportedWarp } from './export-rules';
import type { XmlElement } from './xml';

/** One referenced audio asset, resolved to its zip path and media facts. */
export interface AudioAssetEntry {
  /** Zip entry path the clips reference (e.g. 'audio/<id>.wav'). */
  path: string;
  /** Channel count of the media file. */
  numChannels: number;
  /** Sample rate of the media file in Hz. */
  sampleRate: number;
  /** Media duration in seconds (estimated when the payload is absent). */
  durationSec: number;
  /** Encoded WAV bytes, or null when the payload is not embedded. */
  bytes: Uint8Array | null;
}

/** Builds one Note element (beats, normalized velocities). */
function noteElement(note: DocumentClip['notes'][number]): XmlElement {
  const vel = clamp01(note.velocity / 127);
  return {
    name: 'Note',
    attributes: {
      time: note.startPpq,
      duration: note.durationPpq,
      channel: note.channel,
      key: note.pitch,
      vel,
      // Release velocity is optional; only emit it when the note actually
      // carries one, so a note without an off-velocity does not gain one (equal
      // to its on-velocity) on the round-trip.
      rel: note.offVelocity !== undefined ? clamp01(note.offVelocity / 127) : undefined,
    },
  };
}

/** Builds one MIDI clip element wrapping its Notes lane (all in beats). */
export function midiClipElement(
  clip: DocumentClip,
  trackIndex: number,
  clipIndex: number,
): XmlElement {
  const attributes: Record<string, string | number | boolean | undefined> = {
    time: clip.startPpq,
    duration: clip.lengthPpq,
    contentTimeUnit: 'beats',
    playStart: clip.sourceOffsetPpq,
    name: clip.name,
  };
  if (clip.loopEnabled) {
    attributes['loopStart'] = clip.sourceOffsetPpq;
    attributes['loopEnd'] =
      clip.sourceOffsetPpq + (clip.loopLengthPpq > 0 ? clip.loopLengthPpq : clip.lengthPpq);
  }
  return {
    name: 'Clip',
    attributes,
    children: [
      {
        name: 'Notes',
        attributes: { id: `notes-${trackIndex}-${clipIndex}` },
        children: clip.notes.map(noteElement),
      },
    ],
  };
}

/**
 * Builds one audio clip element referencing its media file. Clip placement is
 * in beats (the surrounding lanes' time unit); the content offset uses
 * seconds, converted through the project tempo map. Enabled Sonare warps are
 * emitted as the standard beats-to-source-seconds Warps mapping.
 */
export function audioClipElement(
  clip: DocumentClip,
  asset: AudioAssetEntry,
  tempoMap: NormalizedTempoMap,
  trackIndex: number,
  clipIndex: number,
): XmlElement {
  const enabledWarp = exportedWarp(clip);
  const contentOriginPpq = audioContentOriginPpq(clip.startPpq, clip.sourceOffsetPpq);
  const attributes: Record<string, string | number | boolean | undefined> = {
    time: clip.startPpq,
    duration: clip.lengthPpq,
    contentTimeUnit: enabledWarp ? 'beats' : 'seconds',
    playStart: enabledWarp
      ? 0
      : audioContentPpqToSeconds(tempoMap, contentOriginPpq, clip.sourceOffsetPpq),
    name: clip.name,
  };
  if (clip.loopEnabled) {
    // Loop bounds follow the clip's content time unit.
    const loopLengthPpq = clip.loopLengthPpq > 0 ? clip.loopLengthPpq : clip.lengthPpq;
    if (enabledWarp) {
      attributes['loopStart'] = 0;
      attributes['loopEnd'] = loopLengthPpq;
    } else {
      attributes['loopStart'] = audioContentPpqToSeconds(
        tempoMap,
        contentOriginPpq,
        clip.sourceOffsetPpq,
      );
      attributes['loopEnd'] = audioContentPpqToSeconds(
        tempoMap,
        contentOriginPpq,
        clip.sourceOffsetPpq + loopLengthPpq,
      );
    }
  }
  const fadeIn = clip.fadeInPpq ?? 0;
  const fadeOut = clip.fadeOutPpq ?? 0;
  if (fadeIn > 0 || fadeOut > 0) {
    attributes['fadeTimeUnit'] = 'beats';
    if (fadeIn > 0) attributes['fadeInTime'] = fadeIn;
    if (fadeOut > 0) attributes['fadeOutTime'] = fadeOut;
  }
  const audio: XmlElement = {
    name: 'Audio',
    attributes: {
      id: `audio-${trackIndex}-${clipIndex}`,
      // MediaFile recommends an explicit time unit for its duration.
      timeUnit: 'seconds',
      channels: asset.numChannels,
      sampleRate: asset.sampleRate,
      duration: asset.durationSec,
    },
    children: [{ name: 'File', attributes: { path: asset.path, external: false } }],
  };
  if (!enabledWarp) return { name: 'Clip', attributes, children: [audio] };

  const secondsPerSourcePpq = 60 / enabledWarp.sourceBpm;
  const sourceStartSeconds =
    enabledWarp.sourceStartSeconds ?? clip.sourceOffsetPpq * secondsPerSourcePpq;
  const anchors = sanitizeWarpAnchors(enabledWarp.anchors ?? [], clip.lengthPpq);
  const sourceEndSeconds = Math.max(
    enabledWarp.sourceEndSeconds ?? (clip.sourceOffsetPpq + clip.lengthPpq) * secondsPerSourcePpq,
    sourceStartSeconds + (anchors[anchors.length - 1]?.sourceSeconds ?? 0) + 1e-9,
  );
  const warpPoints = [
    { ppq: 0, sourceSeconds: sourceStartSeconds },
    ...anchors.map((anchor) => ({
      ppq: anchor.ppq,
      sourceSeconds: sourceStartSeconds + anchor.sourceSeconds,
    })),
    {
      ppq: clip.lengthPpq,
      sourceSeconds: sourceEndSeconds,
    },
  ];
  return {
    name: 'Clip',
    attributes,
    children: [
      {
        name: 'Warps',
        attributes: {
          id: `warps-${trackIndex}-${clipIndex}`,
          timeUnit: 'beats',
          contentTimeUnit: 'seconds',
        },
        children: [
          audio,
          ...warpPoints.map((point) => ({
            name: 'Warp',
            attributes: { time: point.ppq, contentTime: point.sourceSeconds },
          })),
        ],
      },
    ],
  };
}

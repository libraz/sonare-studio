/**
 * DAWproject exporter: turns a plain project document into a DAWproject
 * archive (https://github.com/bitwig/dawproject), the open interchange format
 * several desktop DAWs read and write.
 *
 * The archive is a zip holding project.xml (structure, transport, arrangement),
 * metadata.xml (title) and, optionally, the referenced audio assets embedded
 * as 16-bit WAV files under audio/. The XML is built with a small pure
 * serializer (./xml.ts), so the exporter runs unchanged inside module workers
 * and jsdom tests.
 *
 * Mapping notes (deliberate deviations, all lossy-by-design):
 * - Sections have no DAWproject element; each section start is exported as a
 *   cue marker named "Section: <name>".
 * - Audio warps/stretching are not exported (clips reference plain files).
 * - Per-clip gain has no DAWproject attribute and is dropped.
 * - Per-clip MIDI expression lanes (CC, pitch bend, channel/poly pressure)
 *   have no portable representation here yet and are dropped.
 * - A VCA group's own fader is not a DAWproject concept; its dB offset is
 *   folded into each member track's channel volume instead.
 * - Send/group/aux routing is flattened: every track addresses the master
 *   channel directly (sends and submix buses are not reconstructed).
 * - Instruments, insert effects and the mastering chain are vendor-specific
 *   device state with no portable representation; only channel volume, pan,
 *   mute and solo travel.
 * - Audio-clip content times use seconds (per the format's convention for
 *   media), converted at the first tempo segment's BPM — the same constant
 *   tempo assumption the offline mixdown renderer makes.
 */

import { strToU8, zipSync } from 'fflate';
import { encodeWav } from '@/export/wav';
import { projectFilename } from '@/lib/filename';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { clampPan, dbToLinear, type MixerStrip } from '@/project/mixer';
import { ppqToSeconds } from '@/project/scheduling';
import type { DocumentClip, DocumentTempoSegment, ProjectDocument } from '@/project/serialization';
import { serializeXml, type XmlElement } from './xml';

/** File extension of DAWproject archives. */
export const DAWPROJECT_FILE_EXTENSION = '.dawproject';

/** DAWproject format version written to the root element. */
const DAWPROJECT_FORMAT_VERSION = '1.0';

/** Application identity written to the <Application> element. */
const APPLICATION_NAME = 'sonare-studio';

/** Default application version (override via options.applicationVersion). */
const DEFAULT_APPLICATION_VERSION = '0.1.0';

/** Fixed zip-entry timestamp keeping the archive bytes deterministic. */
const ZIP_MTIME = '2000-01-01T12:00:00Z';

/** Tempo assumed when the document carries no tempo segment. */
const DEFAULT_TEMPO_BPM = 120;

/** Id of the Transport tempo parameter (tempo automation targets it). */
const TEMPO_PARAMETER_ID = 'tempo';

/** Id of the Transport time-signature parameter. */
const TIME_SIGNATURE_PARAMETER_ID = 'time-signature';

/** Id of the master channel (regular channels name it as their destination). */
const MASTER_CHANNEL_ID = 'master-channel';

/** Options for {@link exportDawproject}. */
export interface DawprojectExportOptions {
  /**
   * True embeds every referenced audio asset as a 16-bit WAV zip entry under
   * audio/ (deduplicated by asset id). False keeps the clip/file structure
   * but writes no audio payloads; file durations are then estimated from the
   * clip windows.
   */
  includeAudio: boolean;
  /**
   * Reserved: rendering MIDI tracks to audio is not supported by this
   * exporter; MIDI tracks always export as note clips.
   */
  renderMidiTracks?: false;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Application version written to the <Application> element. */
  applicationVersion?: string;
}

/** One referenced audio asset, resolved to its zip path and media facts. */
interface AudioAssetEntry {
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

/** Neutral strip values used when a track carries no mixer strip. */
const NEUTRAL_STRIP: Pick<MixerStrip, 'gainDb' | 'pan'> = { gainDb: 0, pan: 0 };

/** Conventional upper bound of a DAWproject linear Volume parameter (+6 dB). */
const DEFAULT_VOLUME_MAX = 2;

/** Maps a [-1, 1] balance pan to the DAWproject normalized [0, 1] range. */
function panToNormalized(pan: number): number {
  return (clampPan(pan) + 1) / 2;
}

/** Clamps a value to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Returns a CSS color when it is hex-formatted (the format DAWproject uses). */
function hexColor(color: string): string | undefined {
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color) ? color : undefined;
}

/** True when the clip carries audio content. */
function isAudioClip(clip: DocumentClip): boolean {
  return (clip.kind ?? 'midi') === 'audio';
}

/** Builds the zip entry path for an asset id, keeping paths unique. */
function audioEntryPath(assetId: string, usedPaths: Set<string>): string {
  const base = assetId.replace(/[^A-Za-z0-9._-]/g, '_');
  let path = `audio/${base}.wav`;
  for (let n = 2; usedPaths.has(path); n++) {
    path = `audio/${base}-${n}.wav`;
  }
  usedPaths.add(path);
  return path;
}

/**
 * Resolves every audio asset referenced by the document. When embedding is on,
 * assets are loaded and encoded as 16-bit WAV; assets that fail to load (or
 * everything, when embedding is off) keep their structural entry with media
 * facts estimated from the document (stereo at the project sample rate, long
 * enough to cover every referencing clip window).
 */
async function collectAudioAssets(
  doc: ProjectDocument,
  tempoBpm: number,
  includeAudio: boolean,
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>,
): Promise<Map<string, AudioAssetEntry>> {
  const assets = new Map<string, AudioAssetEntry>();
  const usedPaths = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isAudioClip(clip) || !clip.assetId) continue;
      const windowSec = ppqToSeconds(clip.sourceOffsetPpq + clip.lengthPpq, tempoBpm);
      const existing = assets.get(clip.assetId);
      if (existing) {
        // Grow the estimated duration so every clip window stays in range.
        if (existing.bytes === null && windowSec > existing.durationSec) {
          existing.durationSec = windowSec;
        }
        continue;
      }
      const entry: AudioAssetEntry = {
        path: audioEntryPath(clip.assetId, usedPaths),
        numChannels: 2,
        sampleRate: doc.sampleRate,
        durationSec: windowSec,
        bytes: null,
      };
      if (includeAudio) {
        try {
          const asset = await loadAudio(clip.assetId);
          entry.numChannels = asset.meta.numChannels;
          entry.sampleRate = asset.meta.sampleRate;
          entry.durationSec = asset.meta.numFrames / asset.meta.sampleRate;
          entry.bytes = encodeWav(asset.channels, asset.meta.sampleRate, { bitDepth: 16 });
        } catch {
          // Missing or unreadable asset: keep the structural reference only.
        }
      }
      assets.set(clip.assetId, entry);
    }
  }
  return assets;
}

/** Builds a RealParameter element (Volume/Pan style). */
function realParameter(
  name: string,
  id: string,
  unit: string,
  value: number,
  min: number,
  max: number,
): XmlElement {
  return { name, attributes: { id, unit, min, max, value } };
}

/** Builds one Channel element from track-level and strip-level state. */
function channelElement(
  id: string,
  role: 'regular' | 'master' | 'effect',
  volume: number,
  pan: number,
  mute: boolean,
  solo: boolean,
  destination?: string,
): XmlElement {
  // Preserve loud gains instead of clamping at +6 dB: widen the parameter's
  // max to fit any value above the conventional bound (a member track folding
  // in a VCA offset can legitimately exceed it) so nothing is silently lost.
  const value = Math.max(0, volume);
  return {
    name: 'Channel',
    attributes: { id, role, audioChannels: 2, solo, destination },
    children: [
      realParameter(
        'Volume',
        `${id}-volume`,
        'linear',
        value,
        0,
        Math.max(DEFAULT_VOLUME_MAX, value),
      ),
      realParameter('Pan', `${id}-pan`, 'normalized', panToNormalized(pan), 0, 1),
      { name: 'Mute', attributes: { id: `${id}-mute`, value: mute } },
    ],
  };
}

/** Builds the Structure track list (regular tracks plus the master track). */
function structureElement(doc: ProjectDocument): XmlElement {
  // A VCA carries no audio of its own; DAWproject has no VCA concept, so its
  // per-member dB offset is folded into each assigned track's channel volume
  // (matching the realtime mixer's per-member gain delta).
  const vcaGainDbById = new Map(
    (doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group.gainDb]),
  );
  const tracks: XmlElement[] = doc.tracks.map((track, index) => {
    const strip = track.mixer ?? NEUTRAL_STRIP;
    const vcaOffsetDb = track.vcaId !== undefined ? (vcaGainDbById.get(track.vcaId) ?? 0) : 0;
    return {
      name: 'Track',
      attributes: {
        id: `track-${index}`,
        contentType: track.kind === 'midi' ? 'notes' : 'audio',
        loaded: true,
        name: track.name,
        color: hexColor(track.color),
      },
      children: [
        channelElement(
          `channel-${index}`,
          track.kind === 'aux' ? 'effect' : 'regular',
          track.volume * dbToLinear(strip.gainDb) * dbToLinear(vcaOffsetDb),
          strip.pan,
          track.mute,
          track.solo,
          MASTER_CHANNEL_ID,
        ),
      ],
    };
  });
  const master = doc.mixer?.master ?? NEUTRAL_STRIP;
  tracks.push({
    name: 'Track',
    attributes: { id: 'master-track', contentType: 'tracks', loaded: true, name: 'Master' },
    children: [
      channelElement(
        MASTER_CHANNEL_ID,
        'master',
        dbToLinear(master.gainDb),
        master.pan,
        false,
        false,
      ),
    ],
  });
  return { name: 'Structure', children: tracks };
}

/** Builds the Transport element (first tempo segment + first time signature). */
function transportElement(doc: ProjectDocument): XmlElement {
  const bpm = doc.tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  const signature = doc.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  return {
    name: 'Transport',
    children: [
      {
        name: 'Tempo',
        attributes: { id: TEMPO_PARAMETER_ID, unit: 'bpm', min: 20, max: 999, value: bpm },
      },
      {
        name: 'TimeSignature',
        attributes: {
          id: TIME_SIGNATURE_PARAMETER_ID,
          numerator: signature.numerator,
          denominator: signature.denominator,
        },
      },
    ],
  };
}

/** True when a tempo segment ramps to a different end tempo. */
function isRampSegment(segment: DocumentTempoSegment): boolean {
  return segment.endBpm !== undefined && segment.endBpm > 0 && segment.endBpm !== segment.bpm;
}

/**
 * Builds the tempo automation points: one point per segment start, plus a
 * ramp-end point (linear interpolation) for segments carrying an end tempo.
 * An open-ended final ramp ends at the arrangement content end; when the
 * content ends before the ramp starts, the ramp degrades to a held tempo.
 */
function tempoAutomationElement(
  segments: ReadonlyArray<DocumentTempoSegment>,
  contentEndPpq: number,
): XmlElement {
  const points: XmlElement[] = [{ name: 'Target', attributes: { parameter: TEMPO_PARAMETER_ID } }];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const ramp = isRampSegment(segment);
    points.push({
      name: 'RealPoint',
      attributes: {
        time: segment.startPpq,
        value: segment.bpm,
        interpolation: ramp ? 'linear' : 'hold',
      },
    });
    if (ramp) {
      const endPpq = i + 1 < segments.length ? segments[i + 1].startPpq : contentEndPpq;
      if (endPpq > segment.startPpq) {
        points.push({
          name: 'RealPoint',
          attributes: { time: endPpq, value: segment.endBpm as number, interpolation: 'hold' },
        });
      }
    }
  }
  return {
    name: 'TempoAutomation',
    attributes: { id: 'tempo-automation', unit: 'bpm' },
    children: points,
  };
}

/** Builds the time-signature automation points (one per document segment). */
function timeSignatureAutomationElement(doc: ProjectDocument): XmlElement {
  return {
    name: 'TimeSignatureAutomation',
    attributes: { id: 'time-signature-automation' },
    children: [
      { name: 'Target', attributes: { parameter: TIME_SIGNATURE_PARAMETER_ID } },
      ...doc.timeSignatures.map(
        (segment): XmlElement => ({
          name: 'TimeSignaturePoint',
          attributes: {
            time: segment.startPpq,
            numerator: segment.numerator,
            denominator: segment.denominator,
          },
        }),
      ),
    ],
  };
}

/**
 * Builds the cue marker list: document markers plus one marker per section
 * start (sections have no DAWproject element), ordered by time.
 */
function markersElement(doc: ProjectDocument): XmlElement | null {
  const markers = [
    ...doc.markers.map((marker) => ({ time: marker.ppq, name: marker.name })),
    ...doc.sections.map((section) => ({
      time: section.startPpq,
      name: `Section: ${section.name}`,
    })),
  ].sort((a, b) => a.time - b.time);
  if (markers.length === 0) return null;
  return {
    name: 'Markers',
    attributes: { id: 'markers' },
    children: markers.map((marker): XmlElement => {
      return { name: 'Marker', attributes: { time: marker.time, name: marker.name } };
    }),
  };
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
      rel: note.offVelocity !== undefined ? clamp01(note.offVelocity / 127) : vel,
    },
  };
}

/** Builds one MIDI clip element wrapping its Notes lane (all in beats). */
function midiClipElement(clip: DocumentClip, trackIndex: number, clipIndex: number): XmlElement {
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
 * seconds, converted at the constant project tempo. Warps are not exported.
 */
function audioClipElement(
  clip: DocumentClip,
  asset: AudioAssetEntry,
  tempoBpm: number,
  trackIndex: number,
  clipIndex: number,
): XmlElement {
  const attributes: Record<string, string | number | boolean | undefined> = {
    time: clip.startPpq,
    duration: clip.lengthPpq,
    contentTimeUnit: 'seconds',
    playStart: ppqToSeconds(clip.sourceOffsetPpq, tempoBpm),
    name: clip.name,
  };
  if (clip.loopEnabled) {
    // Loop bounds follow the clip's content time unit (seconds for audio).
    const loopLengthPpq = clip.loopLengthPpq > 0 ? clip.loopLengthPpq : clip.lengthPpq;
    attributes['loopStart'] = ppqToSeconds(clip.sourceOffsetPpq, tempoBpm);
    attributes['loopEnd'] = ppqToSeconds(clip.sourceOffsetPpq + loopLengthPpq, tempoBpm);
  }
  const fadeIn = clip.fadeInPpq ?? 0;
  const fadeOut = clip.fadeOutPpq ?? 0;
  if (fadeIn > 0 || fadeOut > 0) {
    attributes['fadeTimeUnit'] = 'beats';
    if (fadeIn > 0) attributes['fadeInTime'] = fadeIn;
    if (fadeOut > 0) attributes['fadeOutTime'] = fadeOut;
  }
  return {
    name: 'Clip',
    attributes,
    children: [
      {
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
      },
    ],
  };
}

/** Builds the Arrangement: automation, markers and one clip lane per track. */
function arrangementElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  tempoBpm: number,
): XmlElement {
  const children: XmlElement[] = [];
  if (doc.timeSignatures.length > 1) {
    children.push(timeSignatureAutomationElement(doc));
  }
  if (doc.tempoSegments.length > 1 || doc.tempoSegments.some(isRampSegment)) {
    const contentEndPpq = doc.tracks.reduce(
      (end, track) =>
        track.clips.reduce((max, clip) => Math.max(max, clip.startPpq + clip.lengthPpq), end),
      0,
    );
    children.push(tempoAutomationElement(doc.tempoSegments, contentEndPpq));
  }
  const markers = markersElement(doc);
  if (markers) children.push(markers);

  const trackLanes = doc.tracks.map((track, trackIndex): XmlElement => {
    const lane: XmlElement = {
      name: 'Lanes',
      attributes: { id: `lanes-${trackIndex}`, track: `track-${trackIndex}` },
      children: [],
    };
    if (track.clips.length > 0) {
      lane.children = [
        {
          name: 'Clips',
          attributes: { id: `clips-${trackIndex}` },
          children: track.clips.map((clip, clipIndex) => {
            if (!isAudioClip(clip)) return midiClipElement(clip, trackIndex, clipIndex);
            const asset = clip.assetId !== undefined ? assets.get(clip.assetId) : undefined;
            if (!asset) {
              // Audio clip without a usable asset reference: placement only.
              return {
                name: 'Clip',
                attributes: { time: clip.startPpq, duration: clip.lengthPpq, name: clip.name },
              };
            }
            return audioClipElement(clip, asset, tempoBpm, trackIndex, clipIndex);
          }),
        },
      ];
    }
    return lane;
  });
  children.push({
    name: 'Lanes',
    attributes: { id: 'arrangement-lanes', timeUnit: 'beats' },
    children: trackLanes,
  });
  return { name: 'Arrangement', attributes: { id: 'arrangement' }, children };
}

/** Builds the complete project.xml root element. */
function projectElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  applicationVersion: string,
): XmlElement {
  const tempoBpm = doc.tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  return {
    name: 'Project',
    attributes: { version: DAWPROJECT_FORMAT_VERSION },
    children: [
      {
        name: 'Application',
        attributes: { name: APPLICATION_NAME, version: applicationVersion },
      },
      transportElement(doc),
      structureElement(doc),
      arrangementElement(doc, assets, tempoBpm),
    ],
  };
}

/** Builds the metadata.xml root element (title = project name). */
function metadataElement(doc: ProjectDocument): XmlElement {
  return { name: 'MetaData', children: [{ name: 'Title', text: doc.name }] };
}

/**
 * Exports a project document as a DAWproject archive.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Export options; includeAudio controls audio payload embedding.
 * @returns The .dawproject zip bytes (deterministic for a fixed input).
 */
export async function exportDawproject(
  doc: ProjectDocument,
  options: DawprojectExportOptions,
): Promise<Uint8Array> {
  const tempoBpm = doc.tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const assets = await collectAudioAssets(doc, tempoBpm, options.includeAudio, loadAudio);
  const applicationVersion = options.applicationVersion ?? DEFAULT_APPLICATION_VERSION;
  const entries: Record<string, Uint8Array> = {
    'project.xml': strToU8(serializeXml(projectElement(doc, assets, applicationVersion))),
    'metadata.xml': strToU8(serializeXml(metadataElement(doc))),
  };
  for (const asset of assets.values()) {
    if (asset.bytes !== null) entries[asset.path] = asset.bytes;
  }
  return zipSync(entries, { mtime: ZIP_MTIME });
}

/**
 * Suggests a download filename for a DAWproject export: the project name with
 * filesystem-hostile characters replaced, plus the .dawproject extension.
 */
export function dawprojectFilename(projectName: string): string {
  return projectFilename(projectName, DAWPROJECT_FILE_EXTENSION);
}

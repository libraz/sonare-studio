/**
 * DAWproject exporter: turns a plain project document into a DAWproject
 * archive (https://github.com/bitwig/dawproject), the open interchange format
 * several desktop DAWs read and write.
 *
 * The archive is a zip holding project.xml (structure, transport, arrangement),
 * metadata.xml (title) and, optionally, the referenced audio assets embedded
 * as 24-bit WAV files under audio/. The XML is built with a small pure
 * serializer (./xml.ts), so the exporter runs unchanged inside module workers
 * and jsdom tests.
 *
 * Mapping notes (deliberate deviations, all lossy-by-design):
 * - Sections have no DAWproject element; each section start is exported as a
 *   cue marker named "Section: <name>".
 * - Enabled audio warps are exported as standard beats-to-seconds Warps;
 *   disabled warp metadata remains a plain file reference.
 * - Per-clip gain has no DAWproject attribute and is dropped.
 * - Per-clip MIDI expression lanes have no portable DAWproject representation.
 *   They are kept in the separate Sonare metadata entry so project.xml remains
 *   schema-valid for other DAWs.
 * - A VCA group's own fader is not a DAWproject concept; its dB offset is
 *   folded into each member track's channel volume for portable playback, and
 *   sonare-scoped metadata preserves VCA groups/membership for round-trips.
 * - Send buses are exported as DAWproject effect channels; track output bus
 *   routing and pre/post sends are preserved when they address those buses.
 * - Sonare insert effects are exported as generic BuiltinDevice entries so
 *   sonare-to-sonare DAWproject round-trips preserve the chain. Insert
 *   sidechain key sources are preserved as sonare-scoped track indexes on
 *   track, bus and master strips. Other DAWs may ignore these vendor-specific
 *   devices.
 * - Instruments and the mastering chain are vendor-specific device state with
 *   no portable representation; channel volume/pan, mute/solo and fader/pan
 *   automation travel.
 * - Audio-clip content times use seconds (per the format's convention for
 *   media), converted through the project tempo map.
 */

import { strToU8 } from 'fflate';
import { encodeWav } from '@/export/wav';
import { projectFilename } from '@/lib/filename';
import { createStreamingZipWriter } from '@/lib/streaming-zip';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import {
  MAX_DAWPROJECT_ARCHIVE_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import {
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import {
  createMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
  mediaFailureIssues,
} from '@/project/media-completeness';
import {
  clampPan,
  dbToLinear,
  type InsertSlot,
  type MixerStrip,
  type StripSend,
} from '@/project/mixer';
import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentTempoSegment,
  ProjectDocument,
} from '@/project/serialization';
import { type NormalizedTempoMap, normalizeTempoMap } from '@/project/tempo-map';
import { sanitizeWarpAnchors } from '@/project/warp';
import { audioContentOriginPpq, audioContentPpqToSeconds } from './audio-time';
import {
  createSonareDawprojectMetadata,
  SONARE_DAWPROJECT_METADATA_ENTRY,
} from './sonare-metadata';
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

/** Vendor marker used for generic BuiltinDevice insert round-trips. */
const SONARE_DEVICE_VENDOR = 'sonare-studio';

/** Vendor-scoped Target prefix for automation DAWproject cannot name natively. */
const SONARE_AUTOMATION_PARAMETER_PREFIX = 'sonare-automation:';

/** Options for {@link exportDawproject}. */
export interface DawprojectExportOptions {
  /**
   * True embeds every referenced audio asset as a 24-bit WAV zip entry under
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
  /** Cancels asset loading/encoding/ZIP construction between entries. */
  signal?: AbortSignal;
  /**
   * Size budget the export must stay within, defaulting to the values the
   * importer enforces (resource-limits.ts). Exceeding any of them throws a
   * {@link DawprojectSizeError} so the export never yields an unopenable file.
   */
  limits?: DawprojectExportLimits;
}

/** Byte budgets applied while building a DAWproject archive. */
export interface DawprojectExportLimits {
  /** Maximum compressed archive size (default {@link MAX_DAWPROJECT_ARCHIVE_BYTES}). */
  maxArchiveBytes: number;
  /** Maximum total uncompressed embedded audio (default expanded-archive limit). */
  maxExpandedBytes: number;
  /** Maximum single embedded audio payload (default per-entry limit). */
  maxEntryBytes: number;
}

const DEFAULT_DAWPROJECT_EXPORT_LIMITS: DawprojectExportLimits = {
  maxArchiveBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
  maxExpandedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
  maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
};

export interface DawprojectExportResult {
  bytes: Uint8Array;
  completeness: MediaCompletenessReport;
  media: {
    embeddedAssetIds: string[];
    missingAssetIds: string[];
  };
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
const NEUTRAL_STRIP: MixerStrip = { gainDb: 0, pan: 0, inserts: [], sends: [] };

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

/** Sanitizes a dynamic segment used inside DAWproject XML ids. */
function xmlIdSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean.length > 0 ? clean : 'param';
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
 * Error thrown when a DAWproject export would exceed the same budget the
 * importer enforces, so the export never yields an archive this app could not
 * reopen (and never builds an unbounded in-memory buffer set).
 */
export class DawprojectSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DawprojectSizeError';
  }
}

/**
 * Resolves every audio asset referenced by the document. When embedding is on,
 * assets are loaded and encoded as 24-bit WAV; assets that fail to load (or
 * everything, when embedding is off) keep their structural entry with media
 * facts estimated from the document (stereo at the project sample rate, long
 * enough to cover every referencing clip window).
 */
async function collectAudioAssets(
  doc: ProjectDocument,
  tempoMap: NormalizedTempoMap,
  includeAudio: boolean,
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>,
  limits: DawprojectExportLimits,
  signal?: AbortSignal,
): Promise<{ assets: Map<string, AudioAssetEntry>; missingAssetIds: string[] }> {
  const assets = new Map<string, AudioAssetEntry>();
  const missingAssetIds: string[] = [];
  const usedPaths = new Set<string>();
  // Embedded WAV bytes accumulate in memory; bound them by the same expanded
  // budget the importer enforces so a too-large project fails before encoding
  // media it could never re-import (and never holds an unbounded buffer set).
  let embeddedBytes = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isAudioClip(clip) || !clip.assetId) continue;
      const contentOriginPpq = audioContentOriginPpq(clip.startPpq, clip.sourceOffsetPpq);
      const windowSec = audioContentPpqToSeconds(
        tempoMap,
        contentOriginPpq,
        clip.sourceOffsetPpq + clip.lengthPpq,
      );
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
          signal?.throwIfAborted();
          const asset = await loadAudio(clip.assetId);
          signal?.throwIfAborted();
          entry.numChannels = asset.meta.numChannels;
          entry.sampleRate = asset.meta.sampleRate;
          entry.durationSec = asset.meta.numFrames / asset.meta.sampleRate;
          // DAW interchange should not silently quantize the app's float32
          // source store to CD resolution. 24-bit PCM is broadly portable and
          // preserves substantially more source fidelity.
          entry.bytes = encodeWav(asset.channels, asset.meta.sampleRate, { bitDepth: 24 });
          if (entry.bytes.byteLength > limits.maxEntryBytes) {
            throw new DawprojectSizeError(
              `Embedded audio "${clip.assetId}" is too large to export ` +
                `(${entry.bytes.byteLength} bytes; limit ${limits.maxEntryBytes})`,
            );
          }
          embeddedBytes += entry.bytes.byteLength;
          if (embeddedBytes > limits.maxExpandedBytes) {
            throw new DawprojectSizeError(
              `Project has too much embedded audio to export ` +
                `(${embeddedBytes} bytes; limit ${limits.maxExpandedBytes})`,
            );
          }
        } catch (error) {
          if (error instanceof DawprojectSizeError) throw error;
          if (signal?.aborted) signal.throwIfAborted();
          missingAssetIds.push(clip.assetId);
          // Missing or unreadable asset: keep the structural reference only.
        }
      }
      assets.set(clip.assetId, entry);
    }
  }
  return { assets, missingAssetIds };
}

/** Compresses entries incrementally so encoded media can be released immediately. */
async function buildDawprojectZip(
  entries: Iterable<readonly [string, Uint8Array]>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const zip = createStreamingZipWriter({ mtime: ZIP_MTIME, signal });
  try {
    for (const [name, bytes] of entries) {
      await zip.add(name, bytes);
    }
    return await zip.close();
  } catch (error) {
    zip.abort(error);
    throw error;
  }
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

/** Builds one generic DAWproject device for a sonare insert slot. */
function insertDeviceElement(slot: InsertSlot, id: string): XmlElement {
  const parameters = Object.entries(slot.params).flatMap(([name, value]): XmlElement[] => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return [
        {
          name: 'RealParameter',
          attributes: { id: `${id}-param-${xmlIdSegment(name)}`, name, unit: 'normalized', value },
        },
      ];
    }
    if (typeof value === 'boolean') {
      return [
        {
          name: 'BoolParameter',
          attributes: { id: `${id}-param-${xmlIdSegment(name)}`, name, value },
        },
      ];
    }
    return [];
  });
  return {
    name: 'BuiltinDevice',
    attributes: {
      id,
      deviceName: slot.processor,
      deviceRole: 'audioFX',
      deviceVendor: SONARE_DEVICE_VENDOR,
      loaded: true,
    },
    children: [
      ...(parameters.length > 0 ? [{ name: 'Parameters', children: parameters }] : []),
      { name: 'Enabled', attributes: { id: `${id}-enabled`, value: slot.enabled } },
    ],
  };
}

/** Builds the Channel/Devices element for one sonare insert chain. */
function devicesElement(inserts: ReadonlyArray<InsertSlot>, idPrefix: string): XmlElement | null {
  if (inserts.length === 0) return null;
  return {
    name: 'Devices',
    children: inserts.map((slot, index) =>
      insertDeviceElement(slot, `${idPrefix}-insert-${index}`),
    ),
  };
}

/** Builds DAWproject Send elements for a track strip. */
function sendsElement(
  sends: ReadonlyArray<StripSend>,
  busChannelIdByBusId: ReadonlyMap<string, string>,
  channelId: string,
): XmlElement | null {
  const children = sends.flatMap((send, index): XmlElement[] => {
    const destination = busChannelIdByBusId.get(send.busId);
    if (!destination) return [];
    const sendId = `${channelId}-send-${index}`;
    return [
      {
        name: 'Send',
        attributes: {
          id: sendId,
          destination,
          type: send.timing === 'preFader' ? 'pre' : 'post',
        },
        children: [
          { name: 'Mute', attributes: { id: `${sendId}-mute`, value: !send.enabled } },
          realParameter(
            'Volume',
            `${sendId}-volume`,
            'linear',
            Math.max(0, dbToLinear(send.levelDb)),
            0,
            DEFAULT_VOLUME_MAX,
          ),
        ],
      },
    ];
  });
  return children.length > 0 ? { name: 'Sends', children } : null;
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
  sends?: XmlElement | null,
  devices?: XmlElement | null,
): XmlElement {
  // Preserve loud gains instead of clamping at +6 dB: widen the parameter's
  // max to fit any value above the conventional bound (a member track folding
  // in a VCA offset can legitimately exceed it) so nothing is silently lost.
  const value = Math.max(0, volume);
  return {
    name: 'Channel',
    attributes: { id, role, audioChannels: 2, solo, destination },
    children: [
      ...(devices ? [devices] : []),
      { name: 'Mute', attributes: { id: `${id}-mute`, value: mute } },
      realParameter('Pan', `${id}-pan`, 'normalized', panToNormalized(pan), 0, 1),
      ...(sends ? [sends] : []),
      realParameter(
        'Volume',
        `${id}-volume`,
        'linear',
        value,
        0,
        Math.max(DEFAULT_VOLUME_MAX, value),
      ),
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
  const busChannelIdByBusId = new Map(
    (doc.mixer?.buses ?? []).map((bus, index) => [bus.id, `bus-channel-${index}`]),
  );
  const trackElements: XmlElement[] = doc.tracks.map((track, index): XmlElement => {
    const strip = track.mixer ?? NEUTRAL_STRIP;
    const audiblePan = track.mixer?.pan ?? track.pan;
    const vcaOffsetDb = track.vcaId !== undefined ? (vcaGainDbById.get(track.vcaId) ?? 0) : 0;
    const channelId = `channel-${index}`;
    // DAWproject nesting alone does not route audio in every host. Mirror the
    // engine's priority: a valid group owns its member output, ahead of any
    // explicit return-bus route, so the group's fader and inserts stay audible.
    const group = track.groupIndex !== undefined ? doc.tracks[track.groupIndex] : undefined;
    const destination =
      group?.kind === 'group'
        ? `channel-${track.groupIndex}`
        : strip.outputBusId !== undefined
          ? (busChannelIdByBusId.get(strip.outputBusId) ?? MASTER_CHANNEL_ID)
          : MASTER_CHANNEL_ID;
    return {
      name: 'Track',
      attributes: {
        id: `track-${index}`,
        contentType: track.kind === 'group' ? 'tracks' : track.kind === 'midi' ? 'notes' : 'audio',
        loaded: true,
        name: track.name,
        color: hexColor(track.color),
      },
      children: [
        channelElement(
          channelId,
          track.kind === 'aux' ? 'effect' : 'regular',
          track.volume * dbToLinear(strip.gainDb) * dbToLinear(vcaOffsetDb),
          audiblePan,
          track.mute,
          track.solo,
          destination,
          sendsElement(strip.sends ?? [], busChannelIdByBusId, channelId),
          devicesElement(strip.inserts, channelId),
        ),
      ],
    };
  });
  const topLevelTracks: XmlElement[] = [];
  trackElements.forEach((trackElement, index) => {
    const groupIndex = doc.tracks[index].groupIndex;
    const parent =
      groupIndex !== undefined && doc.tracks[groupIndex]?.kind === 'group'
        ? trackElements[groupIndex]
        : undefined;
    if (parent && parent !== trackElement) {
      parent.children = [...(parent.children ?? []), trackElement];
    } else {
      topLevelTracks.push(trackElement);
    }
  });
  const busTracks = (doc.mixer?.buses ?? []).map((bus, index): XmlElement => {
    const strip = bus.strip ?? NEUTRAL_STRIP;
    const channelId = busChannelIdByBusId.get(bus.id) ?? `bus-channel-${index}`;
    return {
      name: 'Track',
      attributes: {
        id: `bus-track-${index}`,
        contentType: 'audio',
        loaded: true,
        name: bus.name,
      },
      children: [
        channelElement(
          channelId,
          'effect',
          dbToLinear(bus.gainDb),
          strip.pan,
          false,
          false,
          MASTER_CHANNEL_ID,
          null,
          devicesElement(strip.inserts, channelId),
        ),
      ],
    };
  });
  const master = doc.mixer?.master ?? NEUTRAL_STRIP;
  return {
    name: 'Structure',
    children: [
      ...topLevelTracks,
      ...busTracks,
      {
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
            undefined,
            null,
            devicesElement(master.inserts, MASTER_CHANNEL_ID),
          ),
        ],
      },
    ],
  };
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
  const pushPoint = (time: number, value: number, interpolation: string): void => {
    const last = points[points.length - 1];
    // A final open-ended ramp emits a hold terminator at the content end, which
    // re-imports as its own held segment whose start point then coincides
    // exactly with that terminator. Collapsing an identical adjacent point keeps
    // DAWproject round-trips idempotent instead of accreting a redundant tail
    // point (points that merely share a time but differ in tempo — a ramp end
    // meeting a jump — are preserved).
    if (
      last.name === 'RealPoint' &&
      last.attributes?.time === time &&
      last.attributes?.value === value &&
      last.attributes?.interpolation === interpolation
    ) {
      return;
    }
    points.push({ name: 'RealPoint', attributes: { time, value, interpolation } });
  };
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const ramp = isRampSegment(segment);
    pushPoint(segment.startPpq, segment.bpm, ramp ? 'linear' : 'hold');
    if (ramp) {
      const endPpq = i + 1 < segments.length ? segments[i + 1].startPpq : contentEndPpq;
      if (endPpq > segment.startPpq) {
        pushPoint(endPpq, segment.endBpm as number, 'hold');
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

function automationInterpolation(curve: DocumentAutomationLane['points'][number]['curve']): string {
  return curve === 'hold' ? 'hold' : 'linear';
}

function channelAutomationPointsElement(
  lane: DocumentAutomationLane,
  idPrefix: string,
  channelId: string,
  strip: MixerStrip | undefined,
  faderOffsetDb = 0,
): XmlElement | null {
  if (!lane.enabled || lane.points.length === 0) return null;
  let parameter: string;
  let unit: string;
  let pointValue: (value: number) => number;
  if (lane.param === 'faderDb') {
    parameter = `${channelId}-volume`;
    unit = 'linear';
    pointValue = (value) => dbToLinear(value + faderOffsetDb);
  } else if (lane.param === 'pan') {
    parameter = `${channelId}-pan`;
    unit = 'normalized';
    pointValue = panToNormalized;
  } else {
    const insertRef = parseInsertAutomationParam(lane.param);
    if (insertRef) {
      const insertIndex = strip ? insertIndexForAutomationRef(strip.inserts, insertRef) : undefined;
      const slot = insertIndex === undefined ? undefined : strip?.inserts[insertIndex];
      const param = slot?.params[insertRef.paramName];
      if (typeof param !== 'number' && typeof param !== 'boolean') return null;
      parameter = `${channelId}-insert-${insertIndex}-param-${xmlIdSegment(insertRef.paramName)}`;
      unit = typeof param === 'boolean' ? 'bool' : 'normalized';
      pointValue =
        typeof param === 'boolean' ? (value) => (value >= 0.5 ? 1 : 0) : (value) => value;
    } else if (
      parseInstrumentAutomationParam(lane.param) !== undefined ||
      parseMasteringAutomationParam(lane.param) !== undefined
    ) {
      // DAWproject has no portable parameter identity for sonare synth patches
      // or mastering processors. Keep their exact token in a vendor Target so
      // sonare can round-trip it; other hosts may safely ignore this lane.
      parameter = `${SONARE_AUTOMATION_PARAMETER_PREFIX}${encodeURIComponent(lane.param)}`;
      unit = 'normalized';
      pointValue = (value) => value;
    } else {
      return null;
    }
  }
  return {
    name: 'Points',
    attributes: {
      id: `automation-${idPrefix}-${xmlIdSegment(lane.param)}`,
      unit,
    },
    children: [
      { name: 'Target', attributes: { parameter } },
      ...lane.points.map(
        (point): XmlElement => ({
          name: 'RealPoint',
          attributes: {
            time: point.ppq,
            value: pointValue(point.value),
            interpolation: automationInterpolation(point.curve),
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
      // Release velocity is optional; only emit it when the note actually
      // carries one, so a note without an off-velocity does not gain one (equal
      // to its on-velocity) on the round-trip.
      rel: note.offVelocity !== undefined ? clamp01(note.offVelocity / 127) : undefined,
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
 * seconds, converted through the project tempo map. Enabled Sonare warps are
 * emitted as the standard beats-to-source-seconds Warps mapping.
 */
function audioClipElement(
  clip: DocumentClip,
  asset: AudioAssetEntry,
  tempoMap: NormalizedTempoMap,
  trackIndex: number,
  clipIndex: number,
): XmlElement {
  const enabledWarp = clip.warp?.enabled === true && clip.warp.sourceBpm > 0 ? clip.warp : null;
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

/** Builds the Arrangement: automation, markers and one clip lane per track. */
function arrangementElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  tempoMap: NormalizedTempoMap,
): XmlElement {
  const vcaGainDbById = new Map(
    (doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group.gainDb]),
  );
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
    const automation = (track.automation ?? [])
      .filter((lane) => !(track.kind === 'group' && lane.param === 'pan'))
      .map((lane) =>
        channelAutomationPointsElement(
          lane,
          String(trackIndex),
          `channel-${trackIndex}`,
          track.mixer,
          track.vcaId === undefined ? 0 : (vcaGainDbById.get(track.vcaId) ?? 0),
        ),
      )
      .filter((element): element is XmlElement => element !== null);
    const lane: XmlElement = {
      name: 'Lanes',
      attributes: { id: `lanes-${trackIndex}`, track: `track-${trackIndex}` },
      children: automation,
    };
    if (track.clips.length > 0) {
      lane.children = [
        ...(lane.children ?? []),
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
            return audioClipElement(clip, asset, tempoMap, trackIndex, clipIndex);
          }),
        },
      ];
    }
    return lane;
  });
  const busLanes = (doc.mixer?.buses ?? []).flatMap((bus, busIndex): XmlElement[] => {
    const strip = bus.strip ?? NEUTRAL_STRIP;
    const automation = (bus.automation ?? [])
      .map((lane) =>
        channelAutomationPointsElement(lane, `bus-${busIndex}`, `bus-channel-${busIndex}`, strip),
      )
      .filter((element): element is XmlElement => element !== null);
    return automation.length > 0
      ? [
          {
            name: 'Lanes',
            attributes: { id: `bus-lanes-${busIndex}`, track: `bus-track-${busIndex}` },
            children: automation,
          },
        ]
      : [];
  });
  const masterAutomation = (doc.masterAutomation ?? [])
    .map((lane) =>
      channelAutomationPointsElement(lane, 'master', MASTER_CHANNEL_ID, doc.mixer?.master),
    )
    .filter((element): element is XmlElement => element !== null);
  const masterLanes: XmlElement[] =
    masterAutomation.length > 0
      ? [
          {
            name: 'Lanes',
            attributes: { id: 'master-lanes', track: 'master-track' },
            children: masterAutomation,
          },
        ]
      : [];
  children.push({
    name: 'Lanes',
    attributes: { id: 'arrangement-lanes', timeUnit: 'beats' },
    children: [...trackLanes, ...busLanes, ...masterLanes],
  });
  return { name: 'Arrangement', attributes: { id: 'arrangement' }, children };
}

/** Builds the complete project.xml root element. */
function projectElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  applicationVersion: string,
  tempoMap: NormalizedTempoMap,
): XmlElement {
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
      arrangementElement(doc, assets, tempoMap),
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
  return (await exportDawprojectWithReport(doc, options)).bytes;
}

/** Exports with a structured report for audio that could not be embedded. */
export async function exportDawprojectWithReport(
  doc: ProjectDocument,
  options: DawprojectExportOptions,
): Promise<DawprojectExportResult> {
  if ((options as { renderMidiTracks?: unknown }).renderMidiTracks === true) {
    throw new RangeError('DAWproject export does not support rendering MIDI tracks to audio');
  }
  const tempoMap = normalizeTempoMap(doc.tempoSegments, DEFAULT_TEMPO_BPM);
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const limits = options.limits ?? DEFAULT_DAWPROJECT_EXPORT_LIMITS;
  options.signal?.throwIfAborted();
  const collected = await collectAudioAssets(
    doc,
    tempoMap,
    options.includeAudio,
    loadAudio,
    limits,
    options.signal,
  );
  const { assets } = collected;
  const applicationVersion = options.applicationVersion ?? DEFAULT_APPLICATION_VERSION;
  const projectXml = strToU8(
    serializeXml(projectElement(doc, assets, applicationVersion, tempoMap)),
  );
  const metadataXml = strToU8(serializeXml(metadataElement(doc)));
  const sonareMetadata = strToU8(JSON.stringify(createSonareDawprojectMetadata(doc)));
  const embeddedAssetIds: string[] = [];
  function* zipEntries(): Generator<readonly [string, Uint8Array]> {
    yield ['project.xml', projectXml];
    yield ['metadata.xml', metadataXml];
    yield [SONARE_DAWPROJECT_METADATA_ENTRY, sonareMetadata];
    for (const [id, asset] of assets) {
      const payload = asset.bytes;
      if (payload !== null) {
        embeddedAssetIds.push(id);
        yield [asset.path, payload];
        asset.bytes = null;
      }
    }
  }
  const bytes = await buildDawprojectZip(zipEntries(), options.signal);
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new DawprojectSizeError(
      `Exported DAWproject archive is too large (${bytes.byteLength} bytes; ` +
        `limit ${limits.maxArchiveBytes})`,
    );
  }
  const issues: MediaCompletenessIssue[] = [];
  for (const id of collected.missingAssetIds) {
    issues.push(...mediaFailureIssues(doc, 'audio-asset', id, 'encode-failed'));
  }
  return {
    bytes,
    completeness: createMediaCompletenessReport(issues),
    media: { embeddedAssetIds, missingAssetIds: collected.missingAssetIds },
  };
}

/**
 * Suggests a download filename for a DAWproject export: the project name with
 * filesystem-hostile characters replaced, plus the .dawproject extension.
 */
export function dawprojectFilename(projectName: string): string {
  return projectFilename(projectName, DAWPROJECT_FILE_EXTENSION);
}

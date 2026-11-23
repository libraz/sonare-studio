/**
 * Sonare-only DAWproject round-trip data.
 *
 * DAWproject's XSD deliberately has no extension points on Project XML. Keep
 * Sonare state in a separate archive entry so project.xml stays portable and
 * schema-valid for other DAWs.
 */

import { isSectionId } from '@/compose/section-shaping';
import { MEBIBYTE } from '@/lib/bytes';
import { isFiniteNumber } from '@/lib/math';
import { type EditorChordSymbol, sanitizeChordSymbols } from '@/project/chords';
import type { DocumentInsertSlot } from '@/project/document-mixer-references';
import type { InsertSlot, VcaGroup } from '@/project/mixer';
import type { DocumentClip, DocumentSection, ProjectDocument } from '@/project/serialization';
import { MAX_SMF_SYSEX_BYTES, MAX_SMF_SYSEX_PACKETS } from '@/project/smf-shared';
import type { SmfSysExPacket, TrackRole } from '@/project/types';
import { busChannelId, MASTER_CHANNEL_ID } from './format';

/** Vendor marker used for generic BuiltinDevice insert round-trips. */
export const SONARE_DEVICE_VENDOR = 'sonare-studio';
export const SONARE_DAWPROJECT_METADATA_ENTRY = 'sonare-studio.json';
/** Dedicated bound for the optional vendor extension, below generic ZIP limits. */
export const MAX_SONARE_DAWPROJECT_METADATA_BYTES = 4 * MEBIBYTE;
const MAX_METADATA_OBJECT_ENTRIES = 4096;
const MAX_METADATA_STRING_LENGTH = 1024;

export interface SonareTrackMetadata {
  kind?: 'aux';
  stripGainDb?: number;
  vcaId?: string;
  role?: TrackRole;
  volume?: number;
}

type SonareMidiExpression = Pick<
  DocumentClip,
  'ccLanes' | 'pitchBendLanes' | 'programChangeLanes' | 'channelPressureLanes' | 'polyPressureLanes'
>;

export interface SonareDawprojectMetadata {
  schemaVersion: 1;
  sidechainSources?: Record<string, number>;
  tracks?: Record<string, SonareTrackMetadata>;
  vcaGroups?: VcaGroup[];
  sections?: DocumentSection[];
  /** Chord annotations have no portable DAWproject counterpart. */
  chords?: EditorChordSymbol[];
  /** MIDI expression is vendor data: DAWproject has no portable clip lane. */
  midiExpressions?: Record<string, SonareMidiExpression>;
  /** Imported SMF SysEx per clip; DAWproject has no SysEx event. */
  midiSysEx?: Record<string, SmfSysExPacket[]>;
  /** Anacrusis length; DAWproject has no pickup-measure concept. */
  pickupLengthPpq?: number;
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function sidechainSourceIndex(slot: InsertSlot, trackCount: number): number | undefined {
  const index: unknown = (slot as DocumentInsertSlot).sidechainSourceIndex;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < trackCount
    ? index
    : undefined;
}

function collectSidechains(
  out: Record<string, number>,
  idPrefix: string,
  inserts: ReadonlyArray<InsertSlot>,
  trackCount: number,
): void {
  inserts.forEach((slot, index) => {
    const source = sidechainSourceIndex(slot, trackCount);
    if (source !== undefined) out[`${idPrefix}-insert-${index}`] = source;
  });
}

const midiExpressionKeys = [
  'ccLanes',
  'pitchBendLanes',
  'programChangeLanes',
  'channelPressureLanes',
  'polyPressureLanes',
] as const;

function midiExpression(clip: DocumentClip): SonareMidiExpression | undefined {
  const out: SonareMidiExpression = {};
  for (const key of midiExpressionKeys) {
    const lanes = clip[key];
    if (lanes?.length)
      Object.assign(out, {
        [key]: lanes.map((lane) => ({
          ...lane,
          points: lane.points.map((point) => ({ ...point })),
        })),
      });
  }
  return Object.keys(out).length ? out : undefined;
}

/** Builds the optional vendor extension entry for a Sonare DAWproject export. */
export function createSonareDawprojectMetadata(doc: ProjectDocument): SonareDawprojectMetadata {
  const tracks: Record<string, SonareTrackMetadata> = {};
  const sidechainSources: Record<string, number> = {};
  const midiExpressions: Record<string, SonareMidiExpression> = {};
  const midiSysEx: Record<string, SmfSysExPacket[]> = {};
  doc.tracks.forEach((track, index) => {
    const strip = track.mixer;
    tracks[`track-${index}`] = {
      ...(track.kind === 'aux' ? { kind: 'aux' } : {}),
      ...(track.vcaId !== undefined ? { vcaId: track.vcaId } : {}),
      ...(track.role !== undefined ? { role: track.role } : {}),
      ...(finite(track.volume) !== undefined ? { volume: track.volume } : {}),
      ...(finite(strip?.gainDb) !== undefined ? { stripGainDb: strip?.gainDb } : {}),
    };
    if (track.kind !== 'group') {
      collectSidechains(
        sidechainSources,
        `channel-${index}`,
        strip?.inserts ?? [],
        doc.tracks.length,
      );
    }
    track.clips.forEach((clip, clipIndex) => {
      if (clip.kind === 'audio') return;
      const expression = midiExpression(clip);
      if (expression) midiExpressions[`track-${index}-clip-${clipIndex}`] = expression;
      if (clip.smfSysEx?.length) {
        midiSysEx[`track-${index}-clip-${clipIndex}`] = clip.smfSysEx.map((packet) => ({
          ppq: packet.ppq,
          status: packet.status,
          data: [...packet.data],
        }));
      }
    });
  });
  (doc.mixer?.buses ?? []).forEach((bus, index) => {
    collectSidechains(
      sidechainSources,
      busChannelId(index),
      bus.strip?.inserts ?? [],
      doc.tracks.length,
    );
  });
  collectSidechains(
    sidechainSources,
    MASTER_CHANNEL_ID,
    doc.mixer?.master?.inserts ?? [],
    doc.tracks.length,
  );
  return {
    schemaVersion: 1,
    ...(Object.keys(tracks).length > 0 ? { tracks } : {}),
    ...(doc.mixer?.vcaGroups?.length ? { vcaGroups: doc.mixer.vcaGroups } : {}),
    ...(Object.keys(sidechainSources).length > 0 ? { sidechainSources } : {}),
    ...(doc.sections.length > 0 ? { sections: doc.sections } : {}),
    ...(doc.chords?.length ? { chords: doc.chords.map((chord) => ({ ...chord })) } : {}),
    ...(Object.keys(midiExpressions).length ? { midiExpressions } : {}),
    ...(Object.keys(midiSysEx).length ? { midiSysEx } : {}),
    ...(finite(doc.pickupLengthPpq) !== undefined && (doc.pickupLengthPpq ?? 0) > 0
      ? { pickupLengthPpq: doc.pickupLengthPpq }
      : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalFinite(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function sections(value: unknown): DocumentSection[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_METADATA_OBJECT_ENTRIES).flatMap((item) => {
    const section = object(item);
    const name = section?.name;
    const color = section?.color;
    const startPpq = optionalFinite(section?.startPpq);
    const endPpq = optionalFinite(section?.endPpq);
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > MAX_METADATA_STRING_LENGTH ||
      typeof color !== 'string' ||
      color.length === 0 ||
      color.length > MAX_METADATA_STRING_LENGTH ||
      startPpq === undefined ||
      startPpq < 0 ||
      endPpq === undefined ||
      endPpq <= startPpq
    ) {
      return [];
    }
    return [
      {
        name,
        ...(isSectionId(section?.kind) ? { kind: section.kind } : {}),
        color,
        startPpq,
        endPpq,
      },
    ];
  });
}

function chords(value: unknown): EditorChordSymbol[] {
  if (!Array.isArray(value)) return [];
  const parsed = value.slice(0, MAX_METADATA_OBJECT_ENTRIES).flatMap((item) => {
    const chord = object(item);
    if (!chord) return [];
    const startPpq = optionalFinite(chord.startPpq);
    const endPpq = optionalFinite(chord.endPpq);
    const rootPc = integer(chord.rootPc, 0, 11);
    const quality = integer(chord.quality, 0, 255);
    if (
      startPpq === undefined ||
      startPpq < 0 ||
      endPpq === undefined ||
      endPpq <= startPpq ||
      rootPc === undefined ||
      quality === undefined
    )
      return [];
    const bassPc = integer(chord.bassPc, 0, 11);
    const tones = (value: unknown): number[] =>
      Array.isArray(value)
        ? value.slice(0, 12).flatMap((tone) => {
            const semitone = integer(tone, 0, 11);
            return semitone === undefined ? [] : [semitone];
          })
        : [];
    return [
      {
        startPpq,
        endPpq,
        rootPc,
        quality,
        ...(bassPc === undefined ? {} : { bassPc }),
        ...(tones(chord.extensions).length ? { extensions: tones(chord.extensions) } : {}),
        ...(tones(chord.omissions).length ? { omissions: tones(chord.omissions) } : {}),
        ...(typeof chord.romanNumeral === 'string' &&
        chord.romanNumeral.length <= MAX_METADATA_STRING_LENGTH
          ? { romanNumeral: chord.romanNumeral }
          : {}),
      },
    ];
  });
  return sanitizeChordSymbols(parsed);
}

function boundedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value)
    .filter(([key]) => key.length <= MAX_METADATA_STRING_LENGTH)
    .slice(0, MAX_METADATA_OBJECT_ENTRIES);
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function expressionPoints(value: unknown, field: 'value' | 'program', max: number) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_METADATA_OBJECT_ENTRIES).flatMap((item) => {
    const point = object(item);
    const ppq = optionalFinite(point?.ppq);
    const amount = integer(point?.[field], 0, max);
    if (ppq === undefined || ppq < 0 || amount === undefined) return [];
    const curve = point?.curve;
    return [
      {
        ppq,
        [field]: amount,
        // Files written before the engine spelling carry 's-curve'.
        ...(curve === 'linear' || curve === 'sCurve' ? { curve } : {}),
        ...(curve === 's-curve' ? { curve: 'sCurve' as const } : {}),
      },
    ];
  });
}

function expressionLanes(
  value: unknown,
  kind: keyof SonareMidiExpression,
): SonareMidiExpression[typeof kind] {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_METADATA_OBJECT_ENTRIES).flatMap((item) => {
    const lane = object(item);
    const channel = integer(lane?.channel, 0, 15);
    if (channel === undefined) return [];
    if (kind === 'ccLanes') {
      const controller = integer(lane?.controller, 0, 127);
      const points = expressionPoints(lane?.points, 'value', 127);
      return controller === undefined || points.length === 0
        ? []
        : [{ channel, controller, points }];
    }
    if (kind === 'pitchBendLanes') {
      const points = expressionPoints(lane?.points, 'value', 16383);
      return points.length ? [{ channel, points }] : [];
    }
    if (kind === 'programChangeLanes') {
      const points = expressionPoints(lane?.points, 'program', 127);
      return points.length ? [{ channel, points }] : [];
    }
    if (kind === 'channelPressureLanes') {
      const points = expressionPoints(lane?.points, 'value', 127);
      return points.length ? [{ channel, points }] : [];
    }
    const pitch = integer(lane?.pitch, 0, 127);
    const points = expressionPoints(lane?.points, 'value', 127);
    return pitch === undefined || points.length === 0 ? [] : [{ channel, pitch, points }];
  }) as SonareMidiExpression[typeof kind];
}

function midiExpressions(value: unknown): Record<string, SonareMidiExpression> {
  return Object.fromEntries(
    boundedEntries(object(value) ?? {}).flatMap(([id, value]) => {
      const entry = object(value);
      if (!entry) return [];
      const expression: SonareMidiExpression = {};
      for (const key of midiExpressionKeys) {
        const lanes = expressionLanes(entry[key], key);
        if (lanes?.length) Object.assign(expression, { [key]: lanes });
      }
      return Object.keys(expression).length ? [[id, expression]] : [];
    }),
  );
}

function sysExPackets(value: unknown, budget: { packets: number; bytes: number }) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SmfSysExPacket[] => {
    const packet = object(item);
    const ppq = optionalFinite(packet?.ppq);
    const status = packet?.status;
    const data = packet?.data;
    if (
      ppq === undefined ||
      ppq < 0 ||
      (status !== 0xf0 && status !== 0xf7) ||
      !Array.isArray(data) ||
      !data.every((byte) => integer(byte, 0, 0xff) !== undefined) ||
      budget.packets + 1 > MAX_SMF_SYSEX_PACKETS ||
      budget.bytes + data.length > MAX_SMF_SYSEX_BYTES
    ) {
      return [];
    }
    budget.packets += 1;
    budget.bytes += data.length;
    return [{ ppq, status, data: data as number[] }];
  });
}

function midiSysEx(value: unknown): Record<string, SmfSysExPacket[]> {
  const budget = { packets: 0, bytes: 0 };
  return Object.fromEntries(
    boundedEntries(object(value) ?? {}).flatMap(([id, packets]) => {
      const parsed = sysExPackets(packets, budget);
      return parsed.length ? [[id, parsed]] : [];
    }),
  );
}

/** Parses an untrusted extension entry; malformed fields are discarded. */
export function parseSonareDawprojectMetadata(
  bytes: Uint8Array | undefined,
): SonareDawprojectMetadata {
  if (!bytes || bytes.byteLength > MAX_SONARE_DAWPROJECT_METADATA_BYTES)
    return { schemaVersion: 1 };
  try {
    const root = object(JSON.parse(new TextDecoder().decode(bytes)));
    if (root?.schemaVersion !== 1) return { schemaVersion: 1 };
    const tracks = Object.fromEntries(
      boundedEntries(object(root.tracks) ?? {}).flatMap(([id, value]) => {
        const entry = object(value);
        if (!entry) return [];
        const track: SonareTrackMetadata = {
          ...(entry.kind === 'aux' ? { kind: 'aux' } : {}),
          ...(typeof entry.vcaId === 'string' &&
          entry.vcaId &&
          entry.vcaId.length <= MAX_METADATA_STRING_LENGTH
            ? { vcaId: entry.vcaId }
            : {}),
          ...(entry.role === 'lead' ? { role: 'lead' } : {}),
          ...(optionalFinite(entry.volume) !== undefined ? { volume: entry.volume as number } : {}),
          ...(optionalFinite(entry.stripGainDb) !== undefined
            ? { stripGainDb: entry.stripGainDb as number }
            : {}),
        };
        return [[id, track]];
      }),
    );
    const sidechainSources = Object.fromEntries(
      boundedEntries(object(root.sidechainSources) ?? {}).flatMap(([id, value]) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? [[id, value]] : [],
      ),
    );
    const vcaGroups = (Array.isArray(root.vcaGroups) ? root.vcaGroups : [])
      .slice(0, MAX_METADATA_OBJECT_ENTRIES)
      .flatMap((value) => {
        const group = object(value);
        if (
          !group ||
          typeof group.id !== 'string' ||
          !group.id ||
          group.id.length > MAX_METADATA_STRING_LENGTH
        )
          return [];
        return [
          {
            id: group.id,
            name:
              typeof group.name === 'string' &&
              group.name &&
              group.name.length <= MAX_METADATA_STRING_LENGTH
                ? group.name
                : group.id,
            gainDb: optionalFinite(group.gainDb) ?? 0,
            ...(group.mute === true ? { mute: true } : {}),
            ...(group.solo === true ? { solo: true } : {}),
          },
        ];
      });
    const parsedSections = sections(root.sections);
    const parsedChords = chords(root.chords);
    const parsedMidiExpressions = midiExpressions(root.midiExpressions);
    const parsedMidiSysEx = midiSysEx(root.midiSysEx);
    const pickupLengthPpq = optionalFinite(root.pickupLengthPpq);
    return {
      schemaVersion: 1,
      ...(Object.keys(tracks).length ? { tracks } : {}),
      ...(Object.keys(sidechainSources).length ? { sidechainSources } : {}),
      ...(vcaGroups.length ? { vcaGroups } : {}),
      ...(parsedSections.length ? { sections: parsedSections } : {}),
      ...(parsedChords.length ? { chords: parsedChords } : {}),
      ...(Object.keys(parsedMidiExpressions).length
        ? { midiExpressions: parsedMidiExpressions }
        : {}),
      ...(Object.keys(parsedMidiSysEx).length ? { midiSysEx: parsedMidiSysEx } : {}),
      ...(pickupLengthPpq !== undefined && pickupLengthPpq > 0 ? { pickupLengthPpq } : {}),
    };
  } catch {
    return { schemaVersion: 1 };
  }
}

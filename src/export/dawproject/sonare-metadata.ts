/**
 * Sonare-only DAWproject round-trip data.
 *
 * DAWproject's XSD deliberately has no extension points on Project XML. Keep
 * Sonare state in a separate archive entry so project.xml stays portable and
 * schema-valid for other DAWs.
 */

import type { InsertSlot, VcaGroup } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';

export const SONARE_DAWPROJECT_METADATA_ENTRY = 'sonare-studio.json';
/** Dedicated bound for the optional vendor extension, below generic ZIP limits. */
export const MAX_SONARE_DAWPROJECT_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_OBJECT_ENTRIES = 4096;
const MAX_METADATA_STRING_LENGTH = 1024;

export interface SonareTrackMetadata {
  kind?: 'aux';
  stripGainDb?: number;
  vcaId?: string;
  volume?: number;
}

export interface SonareDawprojectMetadata {
  schemaVersion: 1;
  sidechainSources?: Record<string, number>;
  tracks?: Record<string, SonareTrackMetadata>;
  vcaGroups?: VcaGroup[];
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function sidechainSourceIndex(slot: InsertSlot, trackCount: number): number | undefined {
  const index = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
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

/** Builds the optional vendor extension entry for a Sonare DAWproject export. */
export function createSonareDawprojectMetadata(doc: ProjectDocument): SonareDawprojectMetadata {
  const tracks: Record<string, SonareTrackMetadata> = {};
  const sidechainSources: Record<string, number> = {};
  doc.tracks.forEach((track, index) => {
    const strip = track.mixer;
    tracks[`track-${index}`] = {
      ...(track.kind === 'aux' ? { kind: 'aux' } : {}),
      ...(track.vcaId !== undefined ? { vcaId: track.vcaId } : {}),
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
  });
  (doc.mixer?.buses ?? []).forEach((bus, index) => {
    collectSidechains(
      sidechainSources,
      `bus-channel-${index}`,
      bus.strip?.inserts ?? [],
      doc.tracks.length,
    );
  });
  collectSidechains(
    sidechainSources,
    'master-channel',
    doc.mixer?.master?.inserts ?? [],
    doc.tracks.length,
  );
  return {
    schemaVersion: 1,
    ...(Object.keys(tracks).length > 0 ? { tracks } : {}),
    ...(doc.mixer?.vcaGroups?.length ? { vcaGroups: doc.mixer.vcaGroups } : {}),
    ...(Object.keys(sidechainSources).length > 0 ? { sidechainSources } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value)
    .filter(([key]) => key.length <= MAX_METADATA_STRING_LENGTH)
    .slice(0, MAX_METADATA_OBJECT_ENTRIES);
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
    return {
      schemaVersion: 1,
      ...(Object.keys(tracks).length ? { tracks } : {}),
      ...(Object.keys(sidechainSources).length ? { sidechainSources } : {}),
      ...(vcaGroups.length ? { vcaGroups } : {}),
    };
  } catch {
    return { schemaVersion: 1 };
  }
}

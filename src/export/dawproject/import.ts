/**
 * Minimal DAWproject importer.
 *
 * This intentionally starts with the portable subset that sonare already
 * exports well: project title, transport tempo/meter, track/channel basics,
 * arrangement markers, MIDI and audio clips. Nested event timelines are
 * flattened into Sonare clips, standard beats-to-seconds Warps become Sonare
 * warp metadata, and referenced media is ingested separately because archives
 * may point at external paths.
 */

import { SECTION_MARKER_PREFIX } from '@/export/constants';
import type { LossReport } from '@/export/loss-descriptor';
import { decodeAndIngest, type IngestAudioOptions } from '@/project/audio-import';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';
import { parseArchive, parseArchiveInWorker } from './archive-import';
import {
  assertBeatBasedArrangement,
  attachArrangementAutomation,
  attachArrangementClips,
  attachArrangementMidiExpressions,
  readMarkers,
} from './arrangement-import';
import { IMPORTED_SAMPLE_RATE } from './format';
import {
  type DawprojectImportLoss,
  type DawprojectImportLossKind,
  type DawprojectMediaIssue,
  dawprojectImportLossReport,
} from './import-loss';
import { type DawprojectAudioMedia, ingestEmbeddedAudio } from './media-import';
import {
  parseSonareDawprojectMetadata,
  SONARE_DAWPROJECT_METADATA_ENTRY,
  type SonareDawprojectMetadata,
} from './sonare-metadata';
import {
  applyMixerRouting,
  type ImportedTrack,
  importedTrackMixer,
  readMaster,
  readSonareVcaGroups,
  readTracks,
  rebindDocumentSidechainSourceIndexes,
  rebindImportedSidechainSourceIndexes,
  scrubImportedSidechainSourceIndexes,
} from './structure-import';
import { readTempo, readTimeSignatures } from './transport-import';

export { DawprojectImportError } from './archive-import';
export {
  DAWPROJECT_IMPORT_LOSS_KINDS,
  type DawprojectImportLoss,
  type DawprojectImportLossKind,
  type DawprojectMediaIssue,
} from './import-loss';

import { defaultName } from '@/project/default-names';

export type { DawprojectAudioMedia } from './media-import';

/** Options for {@link importDawprojectWithMedia}. */
export interface DawprojectImportOptions {
  /** Decodes/stores one embedded audio file and returns its asset id. */
  ingestAudio?: (media: DawprojectAudioMedia) => Promise<{ id: string }>;
  /** Asset writer for the default ingester; pass a transaction's save to lease each asset. */
  save?: IngestAudioOptions['save'];
  /** Resolves an external File path to raw bytes. Omitted paths stay placement-only. */
  resolveExternalAudio?: (path: string) => Promise<Uint8Array | null | undefined>;
  /** Cancels archive/media processing between every asynchronous boundary. */
  signal?: AbortSignal;
}

export interface DawprojectImportResult {
  document: ProjectDocument;
  media: {
    imported: string[];
    issues: DawprojectMediaIssue[];
  };
  losses: DawprojectImportLoss[];
  /** Media issues and losses together, as the pre-replace dialog lists them. */
  loss: LossReport<DawprojectImportLossKind>;
}

function readTitle(project: Document, metadata: Document | null): string {
  const fromMeta = metadata?.querySelector('MetaData > Title')?.textContent?.trim();
  if (fromMeta) return fromMeta;
  const application = project.querySelector('Project > Application');
  return application?.getAttribute('name')?.trim() || defaultName('importedDawproject');
}

/** Restores clip expression by the Structure track id, not traversal order. */
function attachSonareMidiExpressions(
  tracks: ImportedTrack[],
  sonareMetadata: SonareDawprojectMetadata,
): void {
  for (const track of tracks) {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.kind === 'audio') return;
      const key = `${track.id}-clip-${clipIndex}`;
      const expression = sonareMetadata.midiExpressions?.[key];
      if (expression) Object.assign(clip, expression);
      const sysEx = sonareMetadata.midiSysEx?.[key];
      if (sysEx) clip.smfSysEx = sysEx;
    });
  }
}

/**
 * Imports a DAWproject archive into sonare's plain project document shape.
 */
export function importDawproject(bytes: Uint8Array): ProjectDocument {
  return importDawprojectParsed(bytes, new Map());
}

function importDawprojectParsed(
  bytes: Uint8Array,
  mediaAssets: ReadonlyMap<string, string>,
): ProjectDocument {
  const { project, metadata, sonareMetadata } = parseArchive(bytes);
  return importDawprojectDocuments(project, metadata, mediaAssets, sonareMetadata).document;
}

function importDawprojectDocuments(
  project: Document,
  metadata: Document | null,
  mediaAssets: ReadonlyMap<string, string>,
  sonareMetadata: SonareDawprojectMetadata = { schemaVersion: 1 },
): { document: ProjectDocument; losses: DawprojectImportLoss[] } {
  assertBeatBasedArrangement(project);
  const losses: DawprojectImportLoss[] = [];
  const vcaGroups = readSonareVcaGroups(project, sonareMetadata);
  const vcaGainDbById = new Map(vcaGroups.map((group) => [group.id, group.gainDb]));
  const tracks = readTracks(project, vcaGainDbById, sonareMetadata, losses);
  const master = readMaster(project, sonareMetadata, losses);
  rebindImportedSidechainSourceIndexes(tracks, master.strip);
  scrubImportedSidechainSourceIndexes(tracks, master.strip);
  const mixer = applyMixerRouting(tracks, master.strip, vcaGroups, losses);
  const tempoSegments = readTempo(project);
  attachArrangementClips(project, tracks, normalizeTempoMap(tempoSegments), mediaAssets, losses);
  attachArrangementMidiExpressions(project, tracks, losses);
  attachSonareMidiExpressions(tracks, sonareMetadata);
  const masterAutomation = attachArrangementAutomation(project, tracks, mixer, master, losses);
  const documentTracks = tracks.filter((track) => !track.isEffectBus);
  const sections = sonareMetadata.sections ?? [];
  const documentIndexByImportedIndex = new Map<number, number>();
  tracks.forEach((track, importedIndex) => {
    if (track.isEffectBus) return;
    documentIndexByImportedIndex.set(importedIndex, documentIndexByImportedIndex.size);
  });
  rebindDocumentSidechainSourceIndexes(tracks, master.strip, documentIndexByImportedIndex);

  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: readTitle(project, metadata),
    sampleRate: IMPORTED_SAMPLE_RATE,
    tempoSegments,
    timeSignatures: readTimeSignatures(project),
    tracks: documentTracks.map((track) => ({
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      volume: track.volume,
      pan: track.pan,
      clips: track.clips,
      ...(track.groupIndex !== undefined && documentIndexByImportedIndex.has(track.groupIndex)
        ? { groupIndex: documentIndexByImportedIndex.get(track.groupIndex) as number }
        : {}),
      ...(track.vcaId !== undefined ? { vcaId: track.vcaId } : {}),
      ...(track.trackRole !== undefined ? { role: track.trackRole } : {}),
      ...(track.automation.length > 0 ? { automation: track.automation } : {}),
      ...importedTrackMixer(track),
    })),
    // Sonare exports sections as portable cue markers too. The metadata entry
    // preserves their end/color, so do not also restore those cues as markers.
    markers: readMarkers(project).filter(
      (marker) =>
        !sections.some(
          (section) =>
            marker.ppq === section.startPpq &&
            marker.name === `${SECTION_MARKER_PREFIX}${section.name}`,
        ),
    ),
    sections,
    ...(sonareMetadata.chords?.length ? { chords: sonareMetadata.chords } : {}),
    ...(sonareMetadata.pickupLengthPpq !== undefined
      ? { pickupLengthPpq: sonareMetadata.pickupLengthPpq }
      : {}),
  };
  if (mixer) doc.mixer = mixer;
  if (masterAutomation.length > 0) doc.masterAutomation = masterAutomation;
  return { document: doc, losses };
}

/**
 * Imports a DAWproject archive and ingests embedded internal audio files.
 */
export async function importDawprojectWithMedia(
  bytes: Uint8Array,
  options: DawprojectImportOptions = {},
): Promise<ProjectDocument> {
  return (await importDawprojectWithMediaResult(bytes, options)).document;
}

/** Imports media with a structured report for missing/resolution/ingest failures. */
export async function importDawprojectWithMediaResult(
  bytes: Uint8Array,
  options: DawprojectImportOptions = {},
): Promise<DawprojectImportResult> {
  options.signal?.throwIfAborted();
  const { entries, project, metadata } = await parseArchiveInWorker(bytes, options.signal);
  assertBeatBasedArrangement(project);
  const sonareMetadata = parseSonareDawprojectMetadata(entries[SONARE_DAWPROJECT_METADATA_ENTRY]);
  const ingestAudio =
    options.ingestAudio ??
    (async (media: DawprojectAudioMedia) =>
      decodeAndIngest(new Uint8Array(media.bytes).buffer, {
        name: media.name,
        analysis: null,
        ...(options.save !== undefined ? { save: options.save } : {}),
      }));
  const media = await ingestEmbeddedAudio(
    project,
    entries,
    ingestAudio,
    options.resolveExternalAudio,
    options.signal,
  );
  options.signal?.throwIfAborted();
  const parsed = importDawprojectDocuments(project, metadata, media.assets, sonareMetadata);
  return {
    document: parsed.document,
    media: { imported: media.imported, issues: media.issues },
    losses: parsed.losses,
    loss: dawprojectImportLossReport(parsed.losses, media.issues),
  };
}

import { linearToDb } from '@/lib/db';
import { audioAssetUri } from '@/persistence/assets';
import type { Project } from '@/wasm/index.js';
import { annotationsFromDocument, type ScoreAnnotations } from './annotations';
import { type AutomationLaneState, sanitizeAutomationEntries } from './automation';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from './chords';
import { sanitizeCompSegments } from './comping';
import { sanitizeExpressionMap } from './expression-map';
import { isExternalStemRole } from './external-stems';
import { sanitizeProvenance } from './generation';
import { cloneInstrument } from './instrument';
import {
  isValidChannel,
  isValidController,
  sanitizeCcPoints,
  sanitizePitchBendPoints,
  sanitizePressurePoints,
} from './midi-cc';
import { isMidiFxNoop, sanitizeMidiFxConfig } from './midi-fx';
import { cloneStrip, createDefaultStrip } from './mixer';
import {
  DEFAULT_SAMPLE_RATE,
  DEFAULT_TEMPO_BPM,
  finiteAtLeast,
  notesToProjectEvents,
  PROJECT_MAX_UNDO_DEPTH,
  placeholderSourceAudio,
} from './runtime';
import type { DocumentClip, ProjectDocument } from './serialization';
import { normalizeTempoMap } from './tempo-map';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipKind,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  EditorClip,
  EditorTrack,
  MidiClipTake,
  SmfSysExPacket,
} from './types';
import { TRACK_COLOR_PALETTE } from './types';
import { installProjectClipWarp, sanitizeClipWarp } from './warp';

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
      // External-stem provenance: unknown roles drop, so a document written by
      // a newer role vocabulary degrades to a plain imported clip.
      if (isExternalStemRole(meta.externalStemRole)) next.externalStemRole = meta.externalStemRole;
      if (typeof meta.contentHash === 'string' && meta.contentHash.length > 0) {
        next.contentHash = meta.contentHash;
      }
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

/** What hydrating a document into a fresh Project leaves for the store to publish. */
export interface HydratedDocument {
  /** Track mirror in document order, carrying the app-only track fields. */
  trackMirror: EditorTrack[];
  /** Automation lanes recovered from the document, keyed to the rebuilt ids. */
  laneMirror: AutomationLaneState[];
  /** Document clip metadata keyed by the clip id the Project allocated. */
  clipMeta: Map<number, DocumentClip>;
  /** Asset id to the Project source id registered for it. */
  loadedSourceIds: Map<string, number>;
  /** First clip the document placed, or -1 when it placed none. */
  firstClipId: number;
  /** Chord track as annotated onto the Project, already sanitized. */
  documentChords: EditorChordSymbol[];
}

/**
 * Fills a freshly created wasm Project from a serialized document.
 *
 * This is the half of loading that only reads the document and writes the
 * native Project: tempo and meter, every track and clip, their sources, the
 * automation lanes and the chord track. It publishes nothing — the store
 * commits the result, and holds its previous Project alive until it does, so
 * a document that fails partway leaves the open project untouched.
 *
 * @param created A new, empty Project to fill.
 * @param doc The document to read.
 * @returns The mirrors and id maps the store needs to publish the result.
 */
export function hydrateProjectFromDocument(
  created: Project,
  doc: ProjectDocument,
): HydratedDocument {
  created.setMaxUndoDepth(PROJECT_MAX_UNDO_DEPTH);
  created.setSampleRate(doc.sampleRate > 0 ? doc.sampleRate : DEFAULT_SAMPLE_RATE);
  const tempo =
    doc.tempoSegments.length > 0 ? doc.tempoSegments : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
  const normalizedTempo = normalizeTempoMap(tempo, DEFAULT_TEMPO_BPM);
  created.setTempoSegments(
    tempo.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
  );
  if (doc.timeSignatures.length > 0) {
    created.setTimeSignatures(doc.timeSignatures.map((s) => ({ ...s })));
  }
  const trackMirror: EditorTrack[] = [];
  const laneMirror: AutomationLaneState[] = [];
  const clipMeta = new Map<number, DocumentClip>();
  const loadedSourceIds = new Map<string, number>();
  let firstClipId = -1;
  doc.tracks.forEach((track, index) => {
    // Group tracks are an app-level concept; the wasm Project stores them
    // as aux tracks.
    const projectKind = track.kind === 'group' ? 'aux' : track.kind;
    const trackId = created.addTrack({ kind: projectKind, name: track.name });
    const documentPan =
      Number.isFinite(track.pan) && track.pan >= -1 && track.pan <= 1 ? track.pan : 0;
    const importedStrip = track.mixer !== undefined ? cloneStrip(track.mixer) : undefined;
    // Schema-v3 files written before the audible-pan migration may only
    // carry DocumentTrack.pan. Promote it into MixerStrip.pan on load.
    // Group buses have no pan DSP, so reject their persisted no-op value
    // by centering both the strip and compatibility mirror.
    if (importedStrip !== undefined) {
      importedStrip.pan =
        track.kind !== 'group' &&
        Number.isFinite(importedStrip.pan) &&
        importedStrip.pan >= -1 &&
        importedStrip.pan <= 1
          ? importedStrip.pan
          : track.kind === 'group'
            ? 0
            : documentPan;
    }
    const audiblePan = track.kind === 'group' ? 0 : (importedStrip?.pan ?? documentPan);
    let migratedStrip =
      importedStrip ??
      (track.kind !== 'group' && audiblePan !== 0
        ? { ...createDefaultStrip(), pan: audiblePan }
        : undefined);
    // `volume` was the pre-v4 linear fader field. Keep accepting it from
    // old documents, but fold it into the canonical dB strip gain before
    // exposing the mirror so a later fader edit cannot double-count it.
    const legacyVolume = finiteAtLeast(track.volume, 0, 1);
    if (legacyVolume !== 1) {
      migratedStrip = cloneStrip(migratedStrip ?? createDefaultStrip());
      migratedStrip.gainDb += linearToDb(legacyVolume);
    }
    const mirrorEntry: EditorTrack = {
      id: trackId,
      name: track.name,
      color: track.color || TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      // Retained only as a v3 document compatibility mirror. New runtime
      // state and all subsequent saves keep it at unity.
      volume: 1,
      pan: audiblePan,
      order: index,
    };
    if (typeof track.musicXmlPartId === 'string' && track.musicXmlPartId.length > 0) {
      mirrorEntry.musicXmlPartId = track.musicXmlPartId;
    }
    // Instrument and mixer strip are app metadata introduced by schema
    // version 3; older documents simply have neither (defaults apply).
    if (track.instrument !== undefined) mirrorEntry.instrument = cloneInstrument(track.instrument);
    if (track.externalMidiMode === 'project') mirrorEntry.externalMidiMode = 'project';
    // Restore the live MIDI-FX transform; drop a no-op so an identity entry
    // never lingers in the mirror or re-serializes.
    if (track.midiFx !== undefined) {
      const midiFx = sanitizeMidiFxConfig(track.midiFx);
      if (!isMidiFxNoop(midiFx)) mirrorEntry.midiFx = midiFx;
    }
    if (track.soloSafe === true) mirrorEntry.soloSafe = true;
    if (typeof track.percussion === 'boolean') mirrorEntry.percussion = track.percussion;
    const generated = sanitizeProvenance(track.generated);
    if (generated !== undefined) mirrorEntry.generated = generated;
    if (track.chordFollow === 'chordTones' || track.chordFollow === 'root') {
      mirrorEntry.chordFollow = track.chordFollow;
    }
    const expressionMap = sanitizeExpressionMap(track.expressionMap);
    if (expressionMap !== undefined) mirrorEntry.expressionMap = expressionMap;
    // Restore the VCA assignment only when the referenced group survives in
    // the document mixer, so dangling ids never leak into the session.
    if (
      typeof track.vcaId === 'string' &&
      (doc.mixer?.vcaGroups ?? []).some((group) => group.id === track.vcaId)
    ) {
      mirrorEntry.vcaId = track.vcaId;
    }
    if (
      track.frozen !== undefined &&
      typeof track.frozen.assetId === 'string' &&
      track.frozen.assetId.length > 0
    ) {
      mirrorEntry.frozen = { assetId: track.frozen.assetId };
    }
    if (
      track.kind === 'audio' &&
      Number.isInteger(track.recordInputChannel) &&
      (track.recordInputChannel as number) >= 0
    ) {
      mirrorEntry.recordInputChannel = track.recordInputChannel as number;
    }
    if (
      track.kind === 'audio' &&
      typeof track.recordInputDeviceId === 'string' &&
      track.recordInputDeviceId.length > 0
    ) {
      mirrorEntry.recordInputDeviceId = track.recordInputDeviceId;
    }
    if (migratedStrip !== undefined) {
      mirrorEntry.mixer = migratedStrip;
      // Insert sidechain sources are stored positionally; rebind them to
      // the freshly assigned track ids after every track exists (below).
    }
    // Track automation rides the track entry; rebind it to the freshly
    // assigned track id (malformed entries are dropped).
    if (track.automation !== undefined) {
      laneMirror.push(
        ...sanitizeAutomationEntries(track.automation, trackId).filter(
          (lane) => !(track.kind === 'group' && lane.param === 'pan'),
        ),
      );
    }
    trackMirror.push(mirrorEntry);
    for (const clip of track.clips) {
      const startPpq = finiteAtLeast(clip.startPpq, 0, 0);
      const lengthPpq = finiteAtLeast(clip.lengthPpq, Number.EPSILON, 1);
      const sourceOffsetPpq = finiteAtLeast(clip.sourceOffsetPpq, 0, 0);
      const gain = finiteAtLeast(clip.gain, 0, 1);
      const safeClip: DocumentClip = {
        ...clip,
        startPpq,
        lengthPpq,
        sourceOffsetPpq,
        gain,
      };
      const isAudio = clip.kind === 'audio' && typeof clip.assetId === 'string';
      let newClipId: number;
      if (isAudio) {
        const assetId = clip.assetId as string;
        const existingSource = loadedSourceIds.get(assetId);
        if (existingSource === undefined) {
          // First clip of this asset registers the by-reference source
          // (with the placeholder PCM the binding insists on).
          newClipId = created.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            sourceOffsetPpq,
            gain,
            ...placeholderSourceAudio(),
            sourceUri: audioAssetUri(assetId),
          });
          loadedSourceIds.set(assetId, created.sourceCount());
          // External-stem provenance rides the source, so replay it once
          // per asset, on the clip that registered the source.
          if (isExternalStemRole(clip.externalStemRole)) {
            created.setAudioSourceMetadata(
              created.sourceCount(),
              typeof clip.contentHash === 'string' ? clip.contentHash : '',
              clip.externalStemRole,
            );
          }
        } else {
          // Later clips register a throwaway placeholder source and are
          // rebound to the asset's shared source right after.
          newClipId = created.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            sourceOffsetPpq,
            gain,
            ...placeholderSourceAudio(),
          });
          created.setClipSource(newClipId, existingSource);
        }
        if ((clip.fadeInPpq ?? 0) > 0 || (clip.fadeOutPpq ?? 0) > 0) {
          created.setClipFade(
            newClipId,
            { lengthPpq: clip.fadeInPpq ?? 0 },
            { lengthPpq: clip.fadeOutPpq ?? 0 },
          );
        }
      } else {
        newClipId = created.addClip({
          trackId,
          isMidi: true,
          startPpq,
          lengthPpq,
          sourceOffsetPpq,
          gain,
        });
        if (clip.notes.length > 0) {
          // notesToProjectEvents reads the module-scope wasm handle, which
          // is already set above.
          created.setMidiEvents(newClipId, notesToProjectEvents(clip.notes));
        }
      }
      if (clip.loopEnabled) {
        created.setClipLoop(
          newClipId,
          'loop',
          finiteAtLeast(clip.loopLengthPpq, Number.EPSILON, lengthPpq),
        );
      }
      if (
        isAudio &&
        clip.warp !== undefined &&
        typeof clip.warp.enabled === 'boolean' &&
        Number.isFinite(clip.warp.sourceBpm) &&
        clip.warp.sourceBpm > 0
      ) {
        installProjectClipWarp(
          created,
          {
            id: newClipId,
            startPpq,
            lengthPpq,
            sourceOffsetPpq,
            warp: sanitizeClipWarp(clip.warp, lengthPpq),
          },
          normalizedTempo,
        );
      }
      clipMeta.set(newClipId, safeClip);
      if (firstClipId < 0) firstClipId = newClipId;
    }
  });

  // Resolve positional group membership and insert sidechain sources onto
  // the freshly assigned track ids (out-of-range or self references drop).
  doc.tracks.forEach((track, index) => {
    const entry = trackMirror[index];
    if (!entry) return;
    if (
      track.groupIndex !== undefined &&
      Number.isInteger(track.groupIndex) &&
      track.groupIndex >= 0 &&
      track.groupIndex < trackMirror.length &&
      track.groupIndex !== index &&
      trackMirror[track.groupIndex].kind === 'group'
    ) {
      entry.groupId = trackMirror[track.groupIndex].id;
    }
    const inserts = track.mixer?.inserts ?? [];
    inserts.forEach((slot, slotIndex) => {
      const sourceIndex = (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
      if (
        entry.kind === 'group' ||
        sourceIndex === undefined ||
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= trackMirror.length ||
        sourceIndex === index
      ) {
        return;
      }
      const target = entry.mixer?.inserts[slotIndex];
      if (target) target.sidechainSourceTrackId = trackMirror[sourceIndex].id;
    });
    // The positional document field must not survive in the mirror (it
    // would re-serialize stale after track reorders).
    for (const slot of entry.mixer?.inserts ?? []) {
      delete (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
    }
  });

  // Replay the chord-track annotation stream onto the rebuilt Project so it
  // round-trips through refresh() below (chords are read back from toJson).
  const documentChords = sanitizeChordSymbols(doc.chords ?? []);
  if (documentChords.length > 0) {
    created.annotateChords(toProjectChordSymbols(documentChords));
  }

  return { trackMirror, laneMirror, clipMeta, loadedSourceIds, firstClipId, documentChords };
}

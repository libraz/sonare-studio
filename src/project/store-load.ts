import type { Project } from '@libraz/libsonare';
import { linearToDb } from '@/lib/db';
import { audioAssetUri } from '@/persistence/assets';
import { annotationsFromDocument, type ScoreAnnotations } from './annotations';
import { type AutomationLaneState, sanitizeAutomationEntries } from './automation';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from './chords';
import { activeTakeIndex, sanitizeCompSegments } from './comping';
import type { DocumentInsertSlot } from './document-mixer-references';
import { sanitizeExpressionMap } from './expression-map';
import { isExternalStemRole } from './external-stems';
import { sanitizeProvenance } from './generation';
import { loadInstrument } from './instrument';
import { isValidChannel } from './midi-cc';
import { isMidiFxNoop, sanitizeMidiFxConfig } from './midi-fx';
import { copyMidiLaneFields, loadMidiLaneFields } from './midi-lane-kinds';
import { cloneStrip, createDefaultStrip } from './mixer';
import { isValidPitchRange } from './pitch-range';
import {
  DEFAULT_SAMPLE_RATE,
  finiteAtLeast,
  notesToProjectEvents,
  PROJECT_MAX_UNDO_DEPTH,
  placeholderSourceAudio,
} from './runtime';
import type { DocumentClip, DocumentNote, ProjectDocument } from './serialization';
import { MAX_SMF_SYSEX_BYTES, MAX_SMF_SYSEX_PACKETS } from './smf';
import { DEFAULT_TEMPO_BPM, normalizeTempoMap } from './tempo-map';
import type {
  ClipKind,
  EditorClip,
  EditorTrack,
  LeadFollowStashEntry,
  MidiClipTake,
  SmfSysExPacket,
} from './types';
import { TRACK_COLOR_PALETTE } from './types';
import { installProjectClipWarp, sanitizeClipWarp } from './warp';

/**
 * Copies a document audio clip's takes and comp segments onto `next`,
 * dropping takes without an asset.
 *
 * @param next Clip mirror entry being built.
 * @param meta Document clip metadata.
 * @param lengthPpq Clip length the comp segments are sanitized against.
 */
function applyAudioTakeMetadata(next: EditorClip, meta: DocumentClip, lengthPpq: number): void {
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
        lengthPpq,
      );
      if (next.compSegments.length === 0) delete next.compSegments;
    }
  }
}

/**
 * Copies a document MIDI clip's takes, active take and comp segments onto
 * `next`, dropping malformed takes and notes.
 *
 * @param next Clip mirror entry being built.
 * @param meta Document clip metadata.
 * @param lengthPpq Clip length the comp segments are sanitized against.
 */
function applyMidiTakeMetadata(next: EditorClip, meta: DocumentClip, lengthPpq: number): void {
  if (!Array.isArray(meta.midiTakes) || meta.midiTakes.length === 0) return;
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
      ...copyMidiLaneFields(take),
    });
  }
  if (takes.length > 0) {
    next.midiTakes = takes;
    next.midiActiveTakeIndex = activeTakeIndex(
      meta.midiActiveTakeIndex === undefined ? undefined : Number(meta.midiActiveTakeIndex),
      takes.length,
    );
    if (Array.isArray(meta.midiCompSegments) && meta.midiCompSegments.length > 0) {
      next.midiCompSegments = sanitizeCompSegments(
        meta.midiCompSegments.map((segment) => ({
          startPpq: Number(segment.startPpq),
          takeIndex: Number(segment.takeIndex),
        })),
        takes.length,
        lengthPpq,
      );
    }
  }
}

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
      applyAudioTakeMetadata(next, meta, clip.lengthPpq);
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
    if (kind === 'midi') applyMidiTakeMetadata(next, meta, clip.lengthPpq);
    // Lanes are MIDI-clip metadata; hydrate and re-sanitize them against the clip window.
    if (kind === 'midi') Object.assign(next, loadMidiLaneFields(meta, clip.lengthPpq));
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
        if (packets.length >= MAX_SMF_SYSEX_PACKETS || totalBytes > MAX_SMF_SYSEX_BYTES) break;
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
 * Sanitizes a stashed lead-follow note (already id-less, source-relative),
 * the same way a MIDI-take note is validated; a malformed note drops the
 * whole stash entry.
 */
function sanitizeStashNote(note: DocumentNote): LeadFollowStashEntry['note'] | undefined {
  const pitch = Math.round(Number(note.pitch));
  const velocity = Math.round(Number(note.velocity));
  const startPpq = Number(note.startPpq);
  const durationPpq = Number(note.durationPpq);
  const channel = Math.round(Number(note.channel));
  const offVelocity =
    note.offVelocity !== undefined ? Math.round(Number(note.offVelocity)) : undefined;
  if (
    !Number.isInteger(pitch) ||
    pitch < 0 ||
    pitch > 127 ||
    !Number.isInteger(velocity) ||
    velocity < 1 ||
    velocity > 127 ||
    !Number.isFinite(startPpq) ||
    startPpq < 0 ||
    !Number.isFinite(durationPpq) ||
    durationPpq <= 0 ||
    !isValidChannel(channel) ||
    (offVelocity !== undefined &&
      (!Number.isInteger(offVelocity) || offVelocity < 1 || offVelocity > 127))
  ) {
    return undefined;
  }
  return {
    pitch,
    velocity,
    startPpq,
    durationPpq,
    channel,
    ...(offVelocity !== undefined ? { offVelocity } : {}),
  };
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
  // DAWproject and saved sessions may contain intentional overlapping clips
  // (for example, a crossfade). The native project defaults to rejecting
  // overlap, so select the matching policy before adding the first clip.
  if (
    doc.tracks.some((track) => {
      const ordered = track.clips
        .map((clip) => ({
          startPpq: finiteAtLeast(clip.startPpq, 0, 0),
          lengthPpq: finiteAtLeast(clip.lengthPpq, Number.EPSILON, 1),
        }))
        .sort((a, b) => a.startPpq - b.startPpq);
      let latestEnd = -Infinity;
      for (const clip of ordered) {
        if (clip.startPpq < latestEnd) return true;
        latestEnd = Math.max(latestEnd, clip.startPpq + clip.lengthPpq);
      }
      return false;
    })
  ) {
    created.setOverlapPolicy('allow');
  }
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
  // Clip ids the Project allocated, in each track's document clip order, so a
  // lead-follow stash's positional clipIndex can be resolved once every clip
  // exists (below).
  const clipIdsByTrackIndex: number[][] = [];
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
    // Group and return buses now have the same stereo pan stage as tracks, so
    // retain their persisted value instead of discarding it.
    if (importedStrip !== undefined) {
      importedStrip.pan =
        Number.isFinite(importedStrip.pan) && importedStrip.pan >= -1 && importedStrip.pan <= 1
          ? importedStrip.pan
          : documentPan;
      if (importedStrip.panMode === 'dualPan' && importedStrip.dualPan === undefined) {
        importedStrip.dualPan = { left: -1, right: 1 };
      }
    }
    const audiblePan = importedStrip?.pan ?? documentPan;
    let migratedStrip =
      importedStrip ??
      (audiblePan !== 0 ? { ...createDefaultStrip(), pan: audiblePan } : undefined);
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
    if (track.instrument !== undefined) mirrorEntry.instrument = loadInstrument(track.instrument);
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
    if (track.pitchRange !== undefined && isValidPitchRange(track.pitchRange)) {
      mirrorEntry.pitchRange = { low: track.pitchRange.low, high: track.pitchRange.high };
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
    const clipIdsForTrack: number[] = [];
    clipIdsByTrackIndex.push(clipIdsForTrack);
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
          loadedSourceIds.set(assetId, created.sources().length);
          // External-stem provenance rides the source, so replay it once
          // per asset, on the clip that registered the source.
          if (isExternalStemRole(clip.externalStemRole)) {
            created.setAudioSourceMetadata({
              sourceId: created.sources().length,
              ...(typeof clip.contentHash === 'string' ? { contentHash: clip.contentHash } : {}),
              externalStemRole: clip.externalStemRole,
            });
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
          created.setClipFade(newClipId, {
            fadeInPpq: clip.fadeInPpq ?? 0,
            fadeOutPpq: clip.fadeOutPpq ?? 0,
          });
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
        created.setClipLoop(newClipId, {
          loopMode: 'loop',
          loopLengthPpq: finiteAtLeast(clip.loopLengthPpq, Number.EPSILON, lengthPpq),
        });
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
      clipIdsForTrack.push(newClipId);
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
    if (
      track.leadFollow !== undefined &&
      Number.isInteger(track.leadFollow.leadTrackIndex) &&
      track.leadFollow.leadTrackIndex >= 0 &&
      track.leadFollow.leadTrackIndex < trackMirror.length &&
      track.leadFollow.leadTrackIndex !== index
    ) {
      // A stash entry's clipIndex addresses this track's own clips, in the
      // same order they were just created (see clipIdsByTrackIndex above); a
      // dangling clip drops only that entry, not the whole relationship.
      const clipIds = clipIdsByTrackIndex[index] ?? [];
      const stash: LeadFollowStashEntry[] = [];
      for (const stashed of track.leadFollow.stash ?? []) {
        if (
          !stashed ||
          !Number.isInteger(stashed.clipIndex) ||
          stashed.clipIndex < 0 ||
          stashed.clipIndex >= clipIds.length
        ) {
          continue;
        }
        const note = sanitizeStashNote(stashed.note);
        if (note === undefined) continue;
        stash.push({ clipId: clipIds[stashed.clipIndex], note });
      }
      entry.leadFollow = { leadTrackId: trackMirror[track.leadFollow.leadTrackIndex].id, stash };
    }
    const inserts = track.mixer?.inserts ?? [];
    inserts.forEach((slot, slotIndex) => {
      const sourceIndex = (slot as DocumentInsertSlot).sidechainSourceIndex;
      if (
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
      delete (slot as DocumentInsertSlot).sidechainSourceIndex;
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

/**
 * Plain-JSON project document: the contract between the editor state and the
 * persistence layer (which zips it into a project file).
 *
 * The wasm Project has its own toJson()/fromJson() pair, but that format
 * cannot be produced without a live wasm instance, so templates and tests
 * could not build documents from it. This document is instead a plain object
 * built from the store mirror; loading replays it through the Project API
 * (addTrack/addClip/setMidiEvents/...), which rebuilds an equivalent Project.
 */

import { linearToDb } from '@/lib/db';
import { midiLearnTargetScope, withMidiLearnTargetScope } from '@/ui/midi/midi-learn';
import {
  annotationsToDocument,
  type ClipScoreAnnotations,
  createDefaultScoreDisplaySettings,
  type DocumentScoreSettings,
} from './annotations';
import { type AutomationLaneState, busAutomationTarget, isBusAutomationTarget } from './automation';
import { exportMixerSnapshotSlots, importMixerSnapshotSlots } from './command/mixer-snapshots';
import { clearHistory } from './commands';
import { controlSurfaceSettingsAreDefault } from './control-surface';
import {
  fromDocumentMixerSnapshotSlots,
  mixerWithSidechainSourceIndices,
  normalizeDocumentSnapshotGroupSidechainKeys,
  resolveMixerSidechainSourceIds,
  stripWithSidechainSourceIds,
  stripWithSidechainSourceIndices,
  toDocumentMixerSnapshotSlots,
  validateDocumentMixerRouting,
} from './document-mixer-references';
import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentMidiCcBinding,
  DocumentMixerState,
  DocumentNote,
  DocumentTrack,
  ProjectDocument,
} from './document-schema';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from './document-schema';
import {
  cloneInstrument,
  type ExternalMidiInstrument,
  validateTrackInstrument,
} from './instrument';
import { cloneCcLanes } from './midi-cc';
import { isMidiFxNoop, sanitizeMidiFxConfig } from './midi-fx';
import { cloneStrip, createDefaultStrip, isDefaultMixerState } from './mixer';
import { isValidPitchRange } from './pitch-range';
import { getProject, useProjectStore } from './store';
import { normalizeProcessorMidiLearnTarget } from './target-reference-registry';
import { type EditorClip, type EditorNote, MAJOR_MODE_MASK } from './types';

export * from './document-schema';

/** Deep-copies a clip mirror entry into the document shape (no session ids). */
function toDocumentClip(
  clip: EditorClip,
  annotations?: Readonly<ClipScoreAnnotations>,
): DocumentClip {
  const out: DocumentClip = {
    name: clip.name,
    startPpq: clip.startPpq,
    lengthPpq: clip.lengthPpq,
    sourceOffsetPpq: clip.sourceOffsetPpq,
    gain: clip.gain,
    loopEnabled: clip.loopEnabled,
    loopLengthPpq: clip.loopLengthPpq,
    notes: clip.notes.map(toDocumentNote),
    kind: clip.kind ?? 'midi',
  };
  if (clip.assetId !== undefined) out.assetId = clip.assetId;
  if (clip.externalStemRole !== undefined) out.externalStemRole = clip.externalStemRole;
  if (clip.contentHash !== undefined) out.contentHash = clip.contentHash;
  if (clip.fadeInPpq !== undefined) out.fadeInPpq = clip.fadeInPpq;
  if (clip.fadeOutPpq !== undefined) out.fadeOutPpq = clip.fadeOutPpq;
  if (clip.takes !== undefined && clip.takes.length > 0) {
    out.takes = clip.takes.map((take) => ({ ...take }));
    if (clip.compSegments !== undefined && clip.compSegments.length > 0) {
      out.compSegments = clip.compSegments.map((segment) => ({ ...segment }));
    }
  }
  if (clip.midiTakes !== undefined && clip.midiTakes.length > 0) {
    out.midiTakes = clip.midiTakes.map((take) => ({
      name: take.name,
      notes: take.notes.map((note) => ({ ...note })),
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
    }));
    out.midiActiveTakeIndex = Math.min(
      Math.max(0, clip.midiActiveTakeIndex ?? clip.midiTakes.length - 1),
      clip.midiTakes.length - 1,
    );
    if (clip.midiCompSegments !== undefined && clip.midiCompSegments.length > 0) {
      out.midiCompSegments = clip.midiCompSegments.map((segment) => ({
        startPpq: segment.startPpq,
        takeIndex: segment.takeIndex,
      }));
    }
  }
  if (clip.warp !== undefined) {
    out.warp = {
      enabled: clip.warp.enabled,
      sourceBpm: clip.warp.sourceBpm,
      ...(clip.warp.sourceStartSeconds !== undefined
        ? { sourceStartSeconds: clip.warp.sourceStartSeconds }
        : {}),
      ...(clip.warp.sourceEndSeconds !== undefined
        ? { sourceEndSeconds: clip.warp.sourceEndSeconds }
        : {}),
      ...(clip.warp.anchors !== undefined && clip.warp.anchors.length > 0
        ? { anchors: clip.warp.anchors.map((anchor) => ({ ...anchor })) }
        : {}),
    };
  }
  const ccLanes = cloneCcLanes(clip.ccLanes);
  if (ccLanes !== undefined) out.ccLanes = ccLanes;
  if (clip.pitchBendLanes !== undefined && clip.pitchBendLanes.length > 0) {
    out.pitchBendLanes = clip.pitchBendLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.programChangeLanes !== undefined && clip.programChangeLanes.length > 0) {
    out.programChangeLanes = clip.programChangeLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.channelPressureLanes !== undefined && clip.channelPressureLanes.length > 0) {
    out.channelPressureLanes = clip.channelPressureLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.polyPressureLanes !== undefined && clip.polyPressureLanes.length > 0) {
    out.polyPressureLanes = clip.polyPressureLanes.map((lane) => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.smfSysEx !== undefined && clip.smfSysEx.length > 0) {
    out.smfSysEx = clip.smfSysEx.map((packet) => ({ ...packet, data: [...packet.data] }));
  }
  if (annotations !== undefined) {
    // Annotations are re-addressed by note content (orphans drop out here).
    const entries = annotationsToDocument(annotations, clip.notes);
    if (entries.length > 0) out.scoreAnnotations = entries;
  }
  return out;
}

/** Deep-copies a store lane into the document shape (placement carries the target). */
function toDocumentAutomationLane(lane: AutomationLaneState): DocumentAutomationLane {
  return {
    param: lane.param,
    points: lane.points.map((point) => ({ ...point })),
    enabled: lane.enabled,
  };
}

/** Deep-copies a note, dropping the editor id. */
function toDocumentNote(note: EditorNote): DocumentNote {
  const out: DocumentNote = {
    pitch: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  };
  if (note.offVelocity !== undefined) out.offVelocity = note.offVelocity;
  return out;
}

/** Deep-copies a stashed lead-follow note (already id-less, source-relative). */
function toDocumentStashNote(note: DocumentNote): DocumentNote {
  const out: DocumentNote = {
    pitch: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  };
  if (note.offVelocity !== undefined) out.offVelocity = note.offVelocity;
  return out;
}

/**
 * Serializes the current project (store mirror + Project sample rate) into a
 * plain {@link ProjectDocument}. The result contains no session ids and is
 * safe to JSON.stringify.
 *
 * @returns A document that {@link loadProjectDocument} restores losslessly.
 * @throws Error when the project store is not initialized.
 */
export function serializeProject(): ProjectDocument {
  const store = useProjectStore();
  const project = getProject();
  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: store.projectName,
    sampleRate: project.getSampleRate(),
    tempoSegments: store.tempoSegments.map((segment) => ({ ...segment })),
    timeSignatures: store.timeSignatures.map((segment) => ({ ...segment })),
    tracks: store.tracks.map((track) => {
      const audiblePan = track.mixer?.pan ?? track.pan;
      const legacyVolume = Number.isFinite(track.volume) && track.volume >= 0 ? track.volume : 1;
      const needsVolumeMigration = legacyVolume !== 1;
      const out: DocumentTrack = {
        name: track.name,
        color: track.color,
        kind: track.kind,
        mute: track.mute,
        solo: track.solo,
        // v4 canonical form: the audible fader lives in mixer.gainDb. Keep a
        // unity value only because the v3 document shape is still consumed by
        // older readers.
        volume: 1,
        // Compatibility mirror for older readers. MixerStrip.pan is the
        // canonical audible value in current projects.
        pan: audiblePan,
        clips: store.clips
          .filter((clip) => clip.trackId === track.id)
          .map((clip) => toDocumentClip(clip, store.scoreAnnotations[clip.id])),
      };
      if (track.musicXmlPartId !== undefined) out.musicXmlPartId = track.musicXmlPartId;
      if (track.instrument !== undefined) out.instrument = cloneInstrument(track.instrument);
      if (track.externalMidiMode === 'project' && store.projectExternalMidi !== null) {
        out.externalMidiMode = 'project';
      }
      // The live MIDI-FX transform rides the track; serialize it only when it
      // actually changes notes (an identity transform stays out of the document).
      if (track.midiFx !== undefined) {
        const midiFx = sanitizeMidiFxConfig(track.midiFx);
        if (!isMidiFxNoop(midiFx)) out.midiFx = midiFx;
      }
      if (track.mixer !== undefined || needsVolumeMigration) {
        const baseMixer = track.mixer ?? createDefaultStrip();
        const mixer = cloneStrip(baseMixer);
        if (needsVolumeMigration) mixer.gainDb += linearToDb(legacyVolume);
        // Insert sidechain sources are session track ids; store them as
        // positional indices (dangling references drop out).
        out.mixer = stripWithSidechainSourceIndices(mixer, store.tracks);
      }
      if (track.groupId !== undefined) {
        const groupIndex = store.tracks.findIndex((entry) => entry.id === track.groupId);
        if (groupIndex >= 0) out.groupIndex = groupIndex;
      }
      if (track.soloSafe === true) out.soloSafe = true;
      // Persist both true and false: false is a meaningful "not percussion"
      // override, distinct from an absent flag (fall back to the heuristic).
      if (track.percussion !== undefined) out.percussion = track.percussion;
      // The generation record says where the track came from, so it survives
      // renames and edits; it is dropped only when there was never one.
      if (track.generated !== undefined) out.generated = { ...track.generated };
      if (track.chordFollow !== undefined) out.chordFollow = track.chordFollow;
      if (track.expressionMap !== undefined) out.expressionMap = track.expressionMap;
      // VCA group ids are app-level strings, stable within a document, so they
      // round-trip directly (dangling ids are dropped on load).
      if (track.vcaId !== undefined) out.vcaId = track.vcaId;
      if (track.frozen !== undefined) out.frozen = { ...track.frozen };
      if (
        track.kind === 'audio' &&
        track.recordInputChannel !== undefined &&
        Number.isInteger(track.recordInputChannel) &&
        track.recordInputChannel >= 0
      ) {
        out.recordInputChannel = track.recordInputChannel;
      }
      if (
        track.kind === 'audio' &&
        typeof track.recordInputDeviceId === 'string' &&
        track.recordInputDeviceId.length > 0
      ) {
        out.recordInputDeviceId = track.recordInputDeviceId;
      }
      // A malformed range never reaches the store through setTrackPitchRange,
      // but a directly mutated mirror is still sanitized before it is written.
      if (track.pitchRange !== undefined && isValidPitchRange(track.pitchRange)) {
        out.pitchRange = { ...track.pitchRange };
      }
      if (track.leadFollow !== undefined) {
        // The followed track and a stash entry's origin clip are session ids
        // with no place in the document; store them positionally like
        // groupIndex (a dangling track reference drops the whole
        // relationship, a dangling clip reference drops just that entry).
        const leadTrackIndex = store.tracks.findIndex(
          (entry) => entry.id === track.leadFollow?.leadTrackId,
        );
        if (leadTrackIndex >= 0) {
          const trackClips = store.clips.filter((clip) => clip.trackId === track.id);
          out.leadFollow = {
            leadTrackIndex,
            stash: track.leadFollow.stash.flatMap((entry) => {
              const clipIndex = trackClips.findIndex((clip) => clip.id === entry.clipId);
              return clipIndex < 0 ? [] : [{ clipIndex, note: toDocumentStashNote(entry.note) }];
            }),
          };
        }
      }
      // Track automation rides the track entry (track ids are session-scoped,
      // so a document never stores lane targets); omitted when there is none.
      const automation = store.automationLanes.filter(
        (lane) => lane.target === track.id && !(track.kind === 'group' && lane.param === 'pan'),
      );
      if (automation.length > 0) out.automation = automation.map(toDocumentAutomationLane);
      return out;
    }),
    markers: store.markers.map((marker) => ({ ppq: marker.ppq, name: marker.name })),
    sections: store.sections.map((section) => ({
      name: section.name,
      color: section.color,
      startPpq: section.startPpq,
      endPpq: section.endPpq,
    })),
  };
  if (store.pickupLengthPpq > 0) doc.pickupLengthPpq = store.pickupLengthPpq;
  if (store.generationSeed > 0) doc.generationSeed = store.generationSeed;
  // An estimated key is never written: it is re-derived from the notes on every
  // load, and freezing it into the document would present the app's own guess
  // back as a key the composer set. Documents that carry no key therefore
  // round-trip unchanged.
  if (
    !store.scaleHighlightEstimated &&
    (!store.scaleHighlight.enabled ||
      store.scaleHighlight.rootPc !== 0 ||
      store.scaleHighlight.modeMask !== MAJOR_MODE_MASK)
  ) {
    doc.scaleHighlight = { ...store.scaleHighlight };
  }
  // Master automation lanes are omitted while there are none, so documents
  // from automation-less sessions look exactly like older ones. Numeric-target
  // lanes were captured on their track entries above (lanes whose track no
  // longer exists drop out naturally).
  const masterLanes = store.automationLanes.filter((lane) => lane.target === 'master');
  if (masterLanes.length > 0) doc.masterAutomation = masterLanes.map(toDocumentAutomationLane);
  // The chord track is omitted while empty, so chord-less documents look
  // exactly like older ones (the loader replays it through annotateChords).
  if (store.chords.length > 0) doc.chords = store.chords.map((chord) => ({ ...chord }));
  // The project mixer state is omitted while it is entirely default, so
  // documents from mixer-less sessions look exactly like older ones.
  if (!isDefaultMixerState(store.mixer)) {
    const mixer = mixerWithSidechainSourceIndices(store.mixer, store.tracks) as DocumentMixerState;
    if ((mixer.soloMode ?? 'inPlace') === 'inPlace') delete mixer.soloMode;
    // The realtime/export engines have no master-send lane. Drop legacy
    // master sends so silent UI-only routing does not persist.
    mixer.master.sends = [];
    for (const bus of mixer.buses) {
      const target = busAutomationTarget(bus.id);
      const automation = store.automationLanes.filter(
        (lane) => lane.target === target && isBusAutomationTarget(lane.target),
      );
      if (automation.length > 0) bus.automation = automation.map(toDocumentAutomationLane);
    }
    doc.mixer = mixer;
  }
  if (store.projectExternalMidi !== null) {
    doc.externalMidiDefault = cloneInstrument(store.projectExternalMidi) as ExternalMidiInstrument;
  }
  // Score display/layout settings are project state. Keep the document compact
  // by emitting only fields that differ from the defaults.
  const scoreDefaults = createDefaultScoreDisplaySettings();
  const scoreSettings = store.scoreDisplaySettings;
  const scoreDocument: DocumentScoreSettings = {};
  if (store.displayTransposeSemitones !== 0) {
    scoreDocument.displayTransposeSemitones = store.displayTransposeSemitones;
  }
  if (scoreSettings.displayQuantizeKey !== scoreDefaults.displayQuantizeKey) {
    scoreDocument.displayQuantizeKey = scoreSettings.displayQuantizeKey;
  }
  if (scoreSettings.chordsEnabled !== scoreDefaults.chordsEnabled) {
    scoreDocument.chordsEnabled = scoreSettings.chordsEnabled;
  }
  if (scoreSettings.fullScoreEnabled !== scoreDefaults.fullScoreEnabled) {
    scoreDocument.fullScoreEnabled = scoreSettings.fullScoreEnabled;
  }
  if (scoreSettings.estimateFingering !== scoreDefaults.estimateFingering) {
    scoreDocument.estimateFingering = scoreSettings.estimateFingering;
  }
  if (scoreSettings.pageFormat !== scoreDefaults.pageFormat) {
    scoreDocument.pageFormat = scoreSettings.pageFormat;
  }
  if (scoreSettings.landscape !== scoreDefaults.landscape) {
    scoreDocument.landscape = scoreSettings.landscape;
  }
  if (scoreSettings.pageMarginMm !== scoreDefaults.pageMarginMm) {
    scoreDocument.pageMarginMm = scoreSettings.pageMarginMm;
  }
  if (scoreSettings.scalePercent !== scoreDefaults.scalePercent) {
    scoreDocument.scalePercent = scoreSettings.scalePercent;
  }
  if (scoreSettings.spacingStaff !== scoreDefaults.spacingStaff) {
    scoreDocument.spacingStaff = scoreSettings.spacingStaff;
  }
  if (scoreSettings.barsPerSystem !== scoreDefaults.barsPerSystem) {
    scoreDocument.barsPerSystem = scoreSettings.barsPerSystem;
  }
  if (scoreSettings.barsPerPage !== scoreDefaults.barsPerPage) {
    scoreDocument.barsPerPage = scoreSettings.barsPerPage;
  }
  if (scoreSettings.grandStaffSplitPitch !== scoreDefaults.grandStaffSplitPitch) {
    scoreDocument.grandStaffSplitPitch = scoreSettings.grandStaffSplitPitch;
  }
  if (scoreSettings.viewZoom !== scoreDefaults.viewZoom) {
    scoreDocument.viewZoom = scoreSettings.viewZoom;
  }
  if (Object.keys(scoreDocument).length > 0) doc.score = scoreDocument;
  // MIDI-learn CC bindings are app-level metadata; omitted while there are none.
  // Track-scoped targets embed a session track id, so they are stored with the
  // track's positional index (rebound on load); 'master' and other global
  // targets are stable and stored verbatim. Dangling track bindings drop out.
  // Sorted for determinism.
  if (store.midiCcBindings.size > 0) {
    const entries: DocumentMidiCcBinding[] = [];
    for (const [target, binding] of store.midiCcBindings.entries()) {
      const normalizedTarget = normalizeProcessorMidiLearnTarget(store, target);
      if (normalizedTarget === null) continue;
      const scope = midiLearnTargetScope(normalizedTarget);
      if (scope === null) continue;
      const out: DocumentMidiCcBinding = {
        target: normalizedTarget,
        channel: binding.channel,
        controller: binding.controller,
      };
      if (binding.kind && binding.kind !== 'cc') {
        out.kind = binding.kind;
        out.parameter = binding.parameter;
      }
      if (scope !== 'master' && scope !== 'global') {
        const index = store.tracks.findIndex((track) => track.id === scope);
        if (index < 0) continue;
        const portable = withMidiLearnTargetScope(normalizedTarget, index);
        if (portable === null) continue;
        out.target = portable;
        out.trackScoped = true;
      }
      entries.push(out);
    }
    if (entries.length > 0) {
      doc.midiCcBindings = entries.sort((a, b) =>
        a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
      );
    }
  }
  // The surface configuration is rig-shaped rather than musical, so an
  // all-default one is omitted to keep untouched documents byte-identical.
  if (!controlSurfaceSettingsAreDefault(store.controlSurface)) {
    doc.controlSurface = { ...store.controlSurface };
  }
  const mixerSnapshots = toDocumentMixerSnapshotSlots(exportMixerSnapshotSlots(), store.tracks);
  if (mixerSnapshots) doc.mixerSnapshots = mixerSnapshots;
  return doc;
}

/**
 * Rebuilds the wasm Project and the store mirror from a document, replacing
 * any open project, then clears the undo/redo history (a loaded document is
 * the new baseline, not an undoable edit).
 *
 * @param doc Document from {@link serializeProject} or a template.
 */
export async function loadProjectDocument(doc: ProjectDocument): Promise<void> {
  const store = useProjectStore();
  if (doc.externalMidiDefault !== undefined) {
    validateTrackInstrument(doc.externalMidiDefault);
    if (doc.externalMidiDefault.kind !== 'external-midi') {
      throw new RangeError('Project externalMidiDefault must be an external-midi instrument');
    }
  }
  // Parse post-load registries before publishing the staged native Project.
  // Positional ids are sufficient for validation; the state is parsed again
  // against the real session ids after the atomic document swap succeeds.
  const validationTracks = doc.tracks.map((track, index) => ({
    id: index + 1,
    kind: track.kind,
  }));
  validateDocumentMixerRouting(doc.mixer, doc.tracks);
  normalizeDocumentSnapshotGroupSidechainKeys(doc.mixerSnapshots, doc.tracks);
  fromDocumentMixerSnapshotSlots(doc.mixerSnapshots, validationTracks);
  await store.loadDocument(doc);
  resolveMixerSidechainSourceIds(store.mixer, store.tracks);
  // `store.loadDocument` resolves legacy track sidechain indices while it
  // rebuilds the native project. Group-bus references live only in the app
  // mixer mirror, so resolve their positional form after the track ids exist.
  store.tracks = store.tracks.map((track) => {
    if (!track.mixer) return track;
    return { ...track, mixer: stripWithSidechainSourceIds(track.mixer, store.tracks, true) };
  });
  clearHistory();
  importMixerSnapshotSlots(fromDocumentMixerSnapshotSlots(doc.mixerSnapshots, store.tracks));
}

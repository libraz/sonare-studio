/**
 * Setup builders for the engine-backed offline renderer: bus/send routing,
 * VCA group offsets, lane specs, SoundFont preload, the MIDI program and the
 * render window. These are pure document-to-program transforms; the main
 * renderer (engine-render.ts) replays their output onto fresh engines.
 */

import { buildMidiClipSchedules, type ScheduledMidiClip } from '@/engine/midi-sync';
import { engineBusSends, groupBusGainDb, MAX_ENGINE_BUSES } from '@/engine/strip-sync';
import { SILENCE_DB } from '@/lib/db';
import { annotationsFromDocument, type NoteArticulation } from '@/project/annotations';
import { effectiveTrackInstrument } from '@/project/instrument';
import {
  effectiveTrackMute,
  type MixerStrip,
  normalizeMixerSoloMode,
  returnSoloRouting,
  tracksWithVcaSolo,
  type VcaControlState,
  vcaOffsetDb,
} from '@/project/mixer';
import { isTrackAudible } from '@/project/scheduling';
import type { ProjectDocument } from '@/project/serialization';
import { collectActiveSoundFontUsage } from '@/project/soundfont-conflicts';
import { type NormalizedTempoMap, ppqToSamples } from '@/project/tempo-map';
import type { EditorClip, EditorTrack, TempoSegment } from '@/project/types';
import type { EngineBus } from '@/wasm/index.js';
import { type EngineClipSpec, RELEASE_TAIL_SECONDS, type SendSpec } from './engine-render-types';

/** One engine track lane spec (numeric ids, optional sends/output bus). */
export interface LaneSpec {
  trackId: number;
  sends?: SendSpec[];
  outputBusId?: number;
}

/** Bus/send routing derived from a document, with the lane specs it feeds. */
export interface BusRouting {
  /** VCA group fader offsets in dB, keyed by group id. */
  vcaGainDbById: Map<string, number>;
  /** VCA group mute/solo state, keyed by group id. */
  vcaControlsById: Map<string, VcaControlState>;
  /** Whether any track is soloed (drives solo-safe handling). */
  anySolo: boolean;
  /** Engine bus number keyed by document send-bus id. */
  busNumberById: Map<string, number>;
  /** Declared engine buses (send buses first, then one per group track). */
  buses: EngineBus[];
  /** Engine bus number keyed by group-track index. */
  groupBusByTrackIndex: Map<number, number>;
  /** Engine lane specs, one per document track. */
  lanes: LaneSpec[];
  /** Already-declared silent sink for return solo audition, if present. */
  discardBusId?: number;
}

/** PPQ window used by contribution planning; null end means project end. */
export interface RenderPpqRange {
  startPpq: number;
  endPpq: number | null;
}

/** True when a positive-length timeline span contributes inside a render window. */
export function ppqSpanIntersectsRange(
  startPpq: number,
  lengthPpq: number,
  range: RenderPpqRange,
): boolean {
  if (!(lengthPpq > 0)) return false;
  return (
    startPpq + lengthPpq > range.startPpq && (range.endPpq === null || startPpq < range.endPpq)
  );
}

/**
 * The document an offline render hears. PFL solo is a monitor cue, not part
 * of the program output, so in PFL mode track and VCA solos are cleared.
 */
export function programOutputDocument(doc: ProjectDocument): ProjectDocument {
  if (normalizeMixerSoloMode(doc.mixer?.soloMode) !== 'pfl') return doc;
  const tracks = doc.tracks.map((track) => (track.solo ? { ...track, solo: false } : track));
  const vcaGroups = doc.mixer?.vcaGroups?.map((group) =>
    group.solo === true ? { ...group, solo: false } : group,
  );
  return {
    ...doc,
    tracks,
    ...(doc.mixer ? { mixer: { ...doc.mixer, ...(vcaGroups ? { vcaGroups } : {}) } } : {}),
  };
}

/**
 * Computes the shared effective audible track set (mute/solo/solo-safe,
 * groups and VCA controls) of the program output. Preflight and rendering use
 * this same projection so media that cannot reach the requested mix never
 * blocks export.
 */
export function documentAudibleTrackIndices(input: ProjectDocument): Set<number> {
  const doc = programOutputDocument(input);
  const vcaControlsById: Map<string, VcaControlState> = new Map(
    (doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group]),
  );
  const tracksForSolo = tracksWithVcaSolo(doc.tracks, vcaControlsById);
  const tracksForAudibility = tracksForSolo.map((track) =>
    effectiveTrackMute(track.mute, track.vcaId, vcaControlsById) ? { ...track, mute: true } : track,
  );
  const groupExpansion = {
    isGroup: (track: ProjectDocument['tracks'][number]) => track.kind === 'group',
    groupKey: (_track: ProjectDocument['tracks'][number], index: number) => index,
    memberGroupKey: (track: ProjectDocument['tracks'][number]) => track.groupIndex,
  };
  const audible = new Set(
    doc.tracks.flatMap((_, index) =>
      isTrackAudible(tracksForAudibility[index], tracksForAudibility, groupExpansion)
        ? [index]
        : [],
    ),
  );
  // A member routed into a muted/VCA-muted group bus cannot reach the master
  // even when its own lane is otherwise audible.
  doc.tracks.forEach((track, index) => {
    if (track.groupIndex === undefined) return;
    const group = doc.tracks[track.groupIndex];
    if (group?.kind === 'group' && effectiveTrackMute(group.mute, group.vcaId, vcaControlsById)) {
      audible.delete(index);
    }
  });
  return audible;
}

/** Media needed before mute/solo gates for PRE sends and external keys. */
export function documentRenderContributorIndices(
  doc: ProjectDocument,
  audible: ReadonlySet<number>,
): Set<number> {
  const allStrips = [
    ...doc.tracks.map((track) => track.mixer),
    doc.mixer?.master,
    ...(doc.mixer?.buses ?? []).map((bus) => bus.strip),
  ];
  const needsPreGateMedia = allStrips.some(
    (strip) =>
      strip?.sends?.some((send) => send.enabled && send.timing === 'preFader') ||
      strip?.inserts?.some(
        (slot) =>
          slot.enabled &&
          ('sidechainSourceIndex' in slot ||
            'sidechainSourceGroupTrackIndex' in slot ||
            slot.sidechainSourceBusId !== undefined),
      ),
  );
  return needsPreGateMedia ? new Set(doc.tracks.map((_, index) => index)) : new Set(audible);
}

function midiStatus(word0: number): number {
  return (word0 >>> 20) & 0xf;
}

/** True when one compiled MIDI schedule has a sounding note in a sample window. */
function midiScheduleHasNoteInRange(
  schedule: ScheduledMidiClip,
  startSample: number,
  endSample: number,
): boolean {
  const active = new Map<number, number[]>();
  const events = [...schedule.events].sort((a, b) => a.renderFrame - b.renderFrame);
  for (const event of events) {
    const word0 = event.word0;
    if (word0 === undefined) continue;
    const status = midiStatus(word0);
    const velocity = word0 & 0x7f;
    const key = (((word0 >>> 16) & 0xf) << 8) | ((word0 >>> 8) & 0x7f);
    if (status === 0x9 && velocity > 0) {
      const starts = active.get(key) ?? [];
      starts.push(event.renderFrame);
      active.set(key, starts);
      continue;
    }
    if (status !== 0x8 && !(status === 0x9 && velocity === 0)) continue;
    const starts = active.get(key);
    const noteStart = starts?.shift();
    if (noteStart !== undefined && noteStart < endSample && event.renderFrame > startSample) {
      return true;
    }
  }
  const scheduleEnd =
    (schedule.startSample ?? 0) + (schedule.lengthSamples ?? Number.POSITIVE_INFINITY);
  return [...active.values()].some((starts) =>
    starts.some((noteStart) => noteStart < endSample && scheduleEnd > startSample),
  );
}

/** Track indices with an audible compiled MIDI note inside the render window. */
export function activeMidiTrackIndicesForRange(
  schedules: ReadonlyArray<ScheduledMidiClip>,
  trackIds: ReadonlyArray<number>,
  audibleTrackIndices: ReadonlySet<number>,
  startSample: number,
  endSample: number,
): Set<number> {
  const trackIndexById = new Map(trackIds.map((trackId, index) => [trackId, index]));
  const active = new Set<number>();
  for (const schedule of schedules) {
    const trackIndex = trackIndexById.get(schedule.destinationId ?? schedule.trackId ?? -1);
    if (trackIndex === undefined || !audibleTrackIndices.has(trackIndex)) continue;
    if (midiScheduleHasNoteInRange(schedule, startSample, endSample)) active.add(trackIndex);
  }
  return active;
}

/**
 * Builds the bus/send routing and lane specs for a document, mirroring live
 * strip-sync ordering: send buses first (sends must reference declared
 * buses), then one bus per group track, with each member's lane gain raised
 * by its VCA group offset.
 *
 * @param doc Plain project document.
 * @param trackIds Synthetic engine track ids, one per document track.
 * @returns The routing maps, declared buses and lane specs.
 */
export function buildBusRouting(doc: ProjectDocument, trackIds: number[]): BusRouting {
  // VCA group fader offsets (id -> dB): a member track's lane gain is raised by
  // its group's offset, exactly as live mixer-sync folds it in. VCAs carry no
  // audio of their own.
  const vcaGainDbById = new Map<string, number>();
  for (const group of doc.mixer?.vcaGroups ?? []) vcaGainDbById.set(group.id, group.gainDb);
  const vcaControlsById: Map<string, VcaControlState> = new Map(
    (doc.mixer?.vcaGroups ?? []).map((group) => [group.id, group]),
  );
  const tracksForSolo = tracksWithVcaSolo(doc.tracks, vcaControlsById);

  // Solo-safe tracks join the solo group whenever any track is soloed, so the
  // mix keeps them audible (master FX returns, cue lanes) instead of ducking
  // them with the rest — matching live mixer-sync.
  const anySolo = tracksForSolo.some((track) => track.solo);

  // Buses first (sends must reference declared buses): the document's send
  // buses in order, then one bus per group track (matching live strip-sync).
  const busNumberById = new Map<string, number>();
  // A soloed return auditions alone: direct outputs are parked on a silent
  // discard bus and every other bus is floored, exactly as live strip-sync
  // does, so an export made while a return is soloed sounds like the audition.
  const returnSolo = returnSoloRouting(doc.mixer?.buses ?? []);
  const buses: EngineBus[] = (doc.mixer?.buses ?? []).map((bus, index) => {
    busNumberById.set(bus.id, index + 1);
    return { busId: index + 1, gainDb: returnSolo.busGainDb(bus) };
  });
  const groupBusByTrackIndex = new Map<number, number>();
  doc.tracks.forEach((track, index) => {
    if (track.kind !== 'group') return;
    const busId = buses.length + 1;
    groupBusByTrackIndex.set(index, busId);
    buses.push({
      busId,
      gainDb: returnSolo.active
        ? SILENCE_DB
        : groupBusGainDb(
            {
              volume: track.volume,
              mute: effectiveTrackMute(track.mute, track.vcaId, vcaControlsById),
              ...(track.mixer !== undefined ? { mixer: track.mixer } : {}),
            } as Parameters<typeof groupBusGainDb>[0],
            vcaOffsetDb(track.vcaId, vcaGainDbById),
          ),
    });
  });
  // One extra silent bus parks the direct outputs during a return solo. The
  // command layer refuses to solo a return when no engine bus slot is free, so
  // a document that overflows the limit here simply keeps its normal routing.
  const discardBusId =
    returnSolo.active && buses.length < MAX_ENGINE_BUSES ? buses.length + 1 : undefined;
  if (discardBusId !== undefined) buses.push({ busId: discardBusId, gainDb: SILENCE_DB });
  // The return bus and group bus share the engine's bus graph. Resolve their
  // main outputs and auxiliary sends only after every bus has a numeric ID.
  const resolveBus = (storeBusId: string) => busNumberById.get(storeBusId);
  for (const bus of doc.mixer?.buses ?? []) {
    const busId = busNumberById.get(bus.id);
    if (busId === undefined) continue;
    const entry = buses[busId - 1];
    const layout = bus.channelLayout ?? 'stereo';
    if (layout !== 'stereo') {
      entry.channelLayout = { mono: 0, stereo: 1, '5.1': 2, '7.1': 3 }[layout];
    }
    const outputBusId = bus.strip?.outputBusId
      ? busNumberById.get(bus.strip.outputBusId)
      : undefined;
    if (outputBusId !== undefined) entry.outputBusId = outputBusId;
    const sends = engineBusSends(bus.strip?.sends, resolveBus, busId);
    if (sends.length > 0) entry.sends = sends;
  }
  for (const [trackIndex, busId] of groupBusByTrackIndex) {
    const strip = doc.tracks[trackIndex]?.mixer;
    const entry = buses[busId - 1];
    const outputBusId = strip?.outputBusId ? busNumberById.get(strip.outputBusId) : undefined;
    if (outputBusId !== undefined) entry.outputBusId = outputBusId;
    const sends = engineBusSends(strip?.sends, resolveBus, busId);
    if (sends.length > 0) entry.sends = sends;
  }
  const lanes = doc.tracks.map((track, index) => {
    const sends: SendSpec[] = engineBusSends(track.mixer?.sends, resolveBus);
    // Output bus: group routing wins; otherwise an explicit per-track output
    // bus (non-group tracks only), resolved to its engine bus number and
    // honored only when the bus was actually declared (matches live
    // strip-sync, which the engine requires).
    let outputBus: number | undefined;
    if (discardBusId !== undefined && track.kind !== 'group') {
      outputBus = discardBusId;
    } else if (track.groupIndex !== undefined) {
      outputBus = groupBusByTrackIndex.get(track.groupIndex);
    } else if (track.kind !== 'group' && track.mixer?.outputBusId !== undefined) {
      const busNumber = busNumberById.get(track.mixer.outputBusId);
      if (busNumber !== undefined) outputBus = busNumber;
    }
    return {
      trackId: trackIds[index],
      ...(sends.length > 0 ? { sends } : {}),
      ...(outputBus !== undefined ? { outputBusId: outputBus } : {}),
    };
  });

  return {
    vcaGainDbById,
    vcaControlsById,
    anySolo,
    busNumberById,
    buses,
    groupBusByTrackIndex,
    lanes,
    discardBusId,
  };
}

/** Why return/bus stems cannot be rendered for a document. */
export type BusStemsBlock = 'bus-graph-full' | 'nested-routing';

/**
 * Decides whether return/bus stems can be rendered for a document that
 * declares return buses; null when they can (or no return bus exists).
 * The renderer throws on a non-null result and the export dialog gates its
 * Bus stems option on the same call.
 *
 * - `bus-graph-full`: every engine bus is taken, leaving none as the silent
 *   sink that isolates direct outputs.
 * - `nested-routing`: a return or group bus feeds another bus or keys a
 *   sidechain from one, so separate per-bus passes would not re-sum to the mix.
 *
 * @param doc Program-output document.
 * @param routing Bus declarations and discard sink from {@link buildBusRouting}.
 */
export function busStemsBlock(
  doc: ProjectDocument,
  routing: Pick<BusRouting, 'buses' | 'discardBusId'>,
): BusStemsBlock | null {
  if ((doc.mixer?.buses ?? []).length === 0) return null;
  if (routing.buses.length >= MAX_ENGINE_BUSES && routing.discardBusId === undefined) {
    return 'bus-graph-full';
  }
  const routesElsewhere = (strip: MixerStrip | undefined): boolean =>
    strip?.outputBusId !== undefined ||
    (strip?.sends.length ?? 0) > 0 ||
    (strip?.inserts.some(
      (slot) =>
        slot.sidechainSourceBusId !== undefined ||
        (slot as { sidechainSourceGroupTrackIndex?: number }).sidechainSourceGroupTrackIndex !==
          undefined,
    ) ??
      false);
  const nested =
    (doc.mixer?.buses ?? []).some((bus) => routesElsewhere(bus.strip)) ||
    doc.tracks.some((track) => track.kind === 'group' && routesElsewhere(track.mixer));
  return nested ? 'nested-routing' : null;
}

/** {@link busStemsBlock} for a raw document, building the bus routing itself. */
export function documentBusStemsBlock(input: ProjectDocument): BusStemsBlock | null {
  const doc = programOutputDocument(input);
  return busStemsBlock(
    doc,
    buildBusRouting(
      doc,
      doc.tracks.map((_, index) => index + 1),
    ),
  );
}

/**
 * Pre-loads each distinct SoundFont referenced by an active MIDI track so the
 * engine passes can configure instruments synchronously. The renderer keeps
 * the engine's single global SoundFont slot stable by bouncing conflicting
 * SF2 tracks in font-fixed pre-fader passes before the final mixer pass.
 *
 * @param doc Plain project document.
 * @param loadFontBytes Resolves a font id to its raw bytes.
 * @param onLoadError Receives non-fatal font-loading errors for the export report.
 * @returns Font bytes keyed by font id.
 */
export async function preloadSoundFonts(
  doc: ProjectDocument,
  loadFontBytes: (fontId: string) => Promise<Uint8Array>,
  activeTrackIndices?: ReadonlySet<number>,
  onLoadError?: (fontId: string, error: unknown) => void,
): Promise<Map<string, Uint8Array>> {
  const fontBytesById = new Map<string, Uint8Array>();
  const activeTracks = doc.tracks.filter(
    (_track, index) => activeTrackIndices === undefined || activeTrackIndices.has(index),
  );
  const soundFontUsage = collectActiveSoundFontUsage(activeTracks, (track) =>
    effectiveTrackInstrument(track, doc.externalMidiDefault),
  );
  for (const fontId of soundFontUsage.fontIds) {
    if (!fontBytesById.has(fontId)) {
      try {
        fontBytesById.set(fontId, await loadFontBytes(fontId));
      } catch (error) {
        onLoadError?.(fontId, error);
      }
    }
  }
  return fontBytesById;
}

/**
 * Builds the MIDI clip schedules through the live builder (velocity-folded
 * clip gain, SF2 preludes, tempo-map-exact sample positions). Returns an
 * empty array when the document has no MIDI clips.
 *
 * @param doc Plain project document.
 * @param trackIds Synthetic engine track ids, one per document track.
 * @param tempoSegments Document tempo segments (already defaulted).
 * @param sampleRate Render sample rate in Hz.
 * @returns The MIDI clip schedules consumed by setMidiClips.
 */
export function buildMidiSchedules(
  doc: ProjectDocument,
  trackIds: number[],
  tempoSegments: ReadonlyArray<TempoSegment>,
  sampleRate: number,
): ScheduledMidiClip[] {
  const midiTracks: EditorTrack[] = doc.tracks.map((track, index) => ({
    id: trackIds[index],
    name: track.name,
    color: track.color,
    kind: track.kind,
    mute: track.mute,
    solo: track.solo,
    volume: track.volume,
    pan: track.pan,
    order: index,
    ...(track.instrument !== undefined ? { instrument: track.instrument } : {}),
    ...(track.mixer !== undefined ? { mixer: track.mixer } : {}),
    ...(track.frozen !== undefined ? { frozen: { ...track.frozen } } : {}),
    ...(track.expressionMap !== undefined ? { expressionMap: track.expressionMap } : {}),
  }));
  const midiClips: EditorClip[] = [];
  // Articulations only matter for tracks that map them, but the lookup is
  // built for every clip so the scheduler can stay ignorant of the mapping.
  const articulations = new Map<number, Map<number, NoteArticulation>>();
  let nextMidiClipId = 1;
  doc.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip) => {
      if ((clip.kind ?? 'midi') !== 'midi') return;
      const clipId = nextMidiClipId;
      midiClips.push({
        id: nextMidiClipId++,
        trackId: trackIds[trackIndex],
        name: clip.name,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
        sourceOffsetPpq: clip.sourceOffsetPpq,
        gain: clip.gain,
        ...(clip.fadeInPpq !== undefined ? { fadeInPpq: clip.fadeInPpq } : {}),
        ...(clip.fadeOutPpq !== undefined ? { fadeOutPpq: clip.fadeOutPpq } : {}),
        loopEnabled: clip.loopEnabled,
        loopLengthPpq: clip.loopLengthPpq,
        // Document notes drop the editor id; synthesize stable ones.
        notes: clip.notes.map((note, noteIndex) => ({ id: noteIndex + 1, ...note })),
        ...(clip.ccLanes !== undefined ? { ccLanes: clip.ccLanes } : {}),
        ...(clip.pitchBendLanes !== undefined ? { pitchBendLanes: clip.pitchBendLanes } : {}),
        ...(clip.programChangeLanes !== undefined
          ? { programChangeLanes: clip.programChangeLanes }
          : {}),
        ...(clip.channelPressureLanes !== undefined
          ? { channelPressureLanes: clip.channelPressureLanes }
          : {}),
        ...(clip.polyPressureLanes !== undefined
          ? { polyPressureLanes: clip.polyPressureLanes }
          : {}),
      });
      if (clip.scoreAnnotations !== undefined && clip.scoreAnnotations.length > 0) {
        const notes = midiClips[midiClips.length - 1].notes;
        const byNote = annotationsFromDocument(clip.scoreAnnotations, notes);
        const marked = new Map<number, NoteArticulation>();
        for (const [noteKey, annotation] of Object.entries(byNote)) {
          if (annotation.articulation === undefined) continue;
          marked.set(Number(noteKey), annotation.articulation);
        }
        if (marked.size > 0) articulations.set(clipId, marked);
      }
    });
  });
  return midiClips.length > 0
    ? buildMidiClipSchedules(
        midiTracks,
        midiClips,
        tempoSegments,
        sampleRate,
        undefined,
        undefined,
        articulations,
      )
    : [];
}

/** The render window in frames, with the source content end it derived from. */
export interface RenderWindow {
  startSample: number;
  endSample: number;
  totalFrames: number;
}

/**
 * Resolves the render window in frames from the PPQ range. An open-ended
 * range (endPpq null) runs to the last clip end plus the release tail.
 *
 * @param doc Plain project document.
 * @param tempoMap Normalized tempo map for PPQ-to-sample conversion.
 * @param range Resolved PPQ range (endPpq null = up to content end).
 * @param sampleRate Render sample rate in Hz.
 * @param releaseTailSeconds Tail appended after content for eligible renders.
 * @param appendReleaseTailForExplicitRange Whether an explicit range gets a tail too.
 * @returns The window's start/end samples and total frame count.
 */
export function resolveRenderWindow(
  doc: ProjectDocument,
  tempoMap: NormalizedTempoMap,
  range: { startPpq: number; endPpq: number | null },
  sampleRate: number,
  releaseTailSeconds = RELEASE_TAIL_SECONDS,
  audioClips: ReadonlyArray<Pick<EngineClipSpec, 'startPpq' | 'lengthSamples'>> = [],
  audibleTrackIndices?: ReadonlySet<number>,
  appendReleaseTailForExplicitRange = false,
): RenderWindow {
  const startSample = ppqToSamples(tempoMap, range.startPpq, sampleRate);
  let endSample: number;
  if (range.endPpq !== null) {
    endSample =
      ppqToSamples(tempoMap, range.endPpq, sampleRate) +
      (appendReleaseTailForExplicitRange
        ? Math.round(Math.max(0, releaseTailSeconds) * sampleRate)
        : 0);
  } else {
    let contentEndPpq = 0;
    for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex += 1) {
      if (audibleTrackIndices && !audibleTrackIndices.has(trackIndex)) continue;
      const track = doc.tracks[trackIndex];
      for (const clip of track.clips) {
        contentEndPpq = Math.max(contentEndPpq, clip.startPpq + clip.lengthPpq);
      }
    }
    let contentEndSample = ppqToSamples(tempoMap, contentEndPpq, sampleRate);
    for (const clip of audioClips) {
      const clipStartSample = ppqToSamples(tempoMap, clip.startPpq, sampleRate);
      contentEndSample = Math.max(contentEndSample, clipStartSample + clip.lengthSamples);
    }
    endSample = contentEndSample + Math.round(Math.max(0, releaseTailSeconds) * sampleRate);
  }
  const totalFrames = Math.max(0, endSample - startSample);
  return { startSample, endSample, totalFrames };
}

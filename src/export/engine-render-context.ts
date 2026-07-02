/**
 * Setup builders for the engine-backed offline renderer: bus/send routing,
 * VCA group offsets, lane specs, SoundFont preload, the MIDI program and the
 * render window. These are pure document-to-program transforms; the main
 * renderer (engine-render.ts) replays their output onto fresh engines.
 */

import { buildMidiClipSchedules } from '@/engine/midi-sync';
import { groupBusGainDb } from '@/engine/strip-sync';
import { vcaOffsetDb } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { type NormalizedTempoMap, ppqToSamples } from '@/project/tempo-map';
import type { EditorClip, EditorTrack, TempoSegment } from '@/project/types';
import type { EngineMidiClipSchedule } from '@/wasm/index.js';
import { RELEASE_TAIL_SECONDS, type SendSpec } from './engine-render-types';

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
  /** Whether any track is soloed (drives solo-safe handling). */
  anySolo: boolean;
  /** Engine bus number keyed by document send-bus id. */
  busNumberById: Map<string, number>;
  /** Declared engine buses (send buses first, then one per group track). */
  buses: Array<{ busId: number; gainDb?: number }>;
  /** Engine bus number keyed by group-track index. */
  groupBusByTrackIndex: Map<number, number>;
  /** Engine lane specs, one per document track. */
  lanes: LaneSpec[];
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

  // Solo-safe tracks join the solo group whenever any track is soloed, so the
  // mix keeps them audible (master FX returns, cue lanes) instead of ducking
  // them with the rest — matching live mixer-sync.
  const anySolo = doc.tracks.some((track) => track.solo);

  // Buses first (sends must reference declared buses): the document's send
  // buses in order, then one bus per group track (matching live strip-sync).
  const busNumberById = new Map<string, number>();
  const buses = (doc.mixer?.buses ?? []).map((bus, index) => {
    busNumberById.set(bus.id, index + 1);
    return { busId: index + 1, gainDb: bus.gainDb };
  });
  const groupBusByTrackIndex = new Map<number, number>();
  doc.tracks.forEach((track, index) => {
    if (track.kind !== 'group') return;
    const busId = buses.length + 1;
    groupBusByTrackIndex.set(index, busId);
    buses.push({
      busId,
      gainDb: groupBusGainDb(
        {
          volume: track.volume,
          mute: track.mute,
          ...(track.mixer !== undefined ? { mixer: track.mixer } : {}),
        } as Parameters<typeof groupBusGainDb>[0],
        vcaOffsetDb(track.vcaId, vcaGainDbById),
      ),
    });
  });
  const lanes = doc.tracks.map((track, index) => {
    const sends: SendSpec[] = (track.mixer?.sends ?? [])
      .filter((send) => busNumberById.has(send.busId))
      .map((send) => ({
        busId: busNumberById.get(send.busId) as number,
        levelDb: send.levelDb,
        enabled: send.enabled,
        // Pre-fader is the only non-default tap; post-fader stays absent so the
        // engine keeps its historical default (matches live strip-sync).
        ...(send.timing === 'preFader' ? { sendTiming: 'preFader' as const } : {}),
      }));
    // Output bus: group routing wins; otherwise an explicit per-track output
    // bus (non-group tracks only), resolved to its engine bus number and
    // honored only when the bus was actually declared (matches live
    // strip-sync, which the engine requires).
    let outputBus: number | undefined;
    if (track.groupIndex !== undefined) {
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

  return { vcaGainDbById, anySolo, busNumberById, buses, groupBusByTrackIndex, lanes };
}

/**
 * Pre-loads each distinct SoundFont referenced by an active MIDI track so the
 * engine passes can configure instruments synchronously. The engine holds a
 * single global SoundFont; when more than one is requested the last loaded
 * font wins (warns, matching live behavior).
 *
 * @param doc Plain project document.
 * @param loadFontBytes Resolves a font id to its raw bytes.
 * @returns Font bytes keyed by font id.
 */
export async function preloadSoundFonts(
  doc: ProjectDocument,
  loadFontBytes: (fontId: string) => Promise<Uint8Array>,
): Promise<Map<string, Uint8Array>> {
  const fontBytesById = new Map<string, Uint8Array>();
  for (const track of doc.tracks) {
    if (track.frozen !== undefined) continue;
    if (track.kind === 'midi' && track.instrument?.kind === 'sf2') {
      if (!fontBytesById.has(track.instrument.fontId)) {
        fontBytesById.set(track.instrument.fontId, await loadFontBytes(track.instrument.fontId));
      }
    }
  }
  if (fontBytesById.size > 1) {
    console.warn(
      `Engine render: ${fontBytesById.size} distinct SoundFonts requested, but the engine holds a single global SoundFont — the last loaded font wins.`,
    );
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
): EngineMidiClipSchedule[] {
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
  }));
  const midiClips: EditorClip[] = [];
  doc.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if ((clip.kind ?? 'midi') !== 'midi') return;
      midiClips.push({
        id: trackIndex * 10_000 + clipIndex + 1,
        trackId: trackIds[trackIndex],
        name: clip.name,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
        sourceOffsetPpq: clip.sourceOffsetPpq,
        gain: clip.gain,
        loopEnabled: clip.loopEnabled,
        loopLengthPpq: clip.loopLengthPpq,
        // Document notes drop the editor id; synthesize stable ones.
        notes: clip.notes.map((note, noteIndex) => ({ id: noteIndex + 1, ...note })),
        ...(clip.ccLanes !== undefined ? { ccLanes: clip.ccLanes } : {}),
        ...(clip.pitchBendLanes !== undefined ? { pitchBendLanes: clip.pitchBendLanes } : {}),
        ...(clip.channelPressureLanes !== undefined
          ? { channelPressureLanes: clip.channelPressureLanes }
          : {}),
        ...(clip.polyPressureLanes !== undefined
          ? { polyPressureLanes: clip.polyPressureLanes }
          : {}),
      });
    });
  });
  return midiClips.length > 0
    ? buildMidiClipSchedules(midiTracks, midiClips, tempoSegments, sampleRate)
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
 * @param releaseTailSeconds Tail appended after content for open project renders.
 * @returns The window's start/end samples and total frame count.
 */
export function resolveRenderWindow(
  doc: ProjectDocument,
  tempoMap: NormalizedTempoMap,
  range: { startPpq: number; endPpq: number | null },
  sampleRate: number,
  releaseTailSeconds = RELEASE_TAIL_SECONDS,
): RenderWindow {
  const startSample = ppqToSamples(tempoMap, range.startPpq, sampleRate);
  let endSample: number;
  if (range.endPpq !== null) {
    endSample = ppqToSamples(tempoMap, range.endPpq, sampleRate);
  } else {
    let contentEndPpq = 0;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        contentEndPpq = Math.max(contentEndPpq, clip.startPpq + clip.lengthPpq);
      }
    }
    endSample =
      ppqToSamples(tempoMap, contentEndPpq, sampleRate) +
      Math.round(Math.max(0, releaseTailSeconds) * sampleRate);
  }
  const totalFrames = Math.max(0, endSample - startSample);
  return { startSample, endSample, totalFrames };
}

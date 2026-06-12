/**
 * Engine-backed offline export renderer: builds a libsonare RealtimeEngine
 * from a plain project document, replays the project state with the same
 * pure builders the live playback sync layers use, and renders the timeline
 * by driving the engine's block processor offline. Because the audio passes
 * through the actual engine (lanes, strips, buses/sends, realtime
 * instruments, automation, tempo map), the export matches live playback by
 * construction.
 *
 * Differences from the legacy renderMixdown path it replaces:
 * - buses and sends are rendered,
 * - automation lanes are rendered,
 * - MIDI tracks play at their live engine level (no per-clip peak
 *   normalization),
 * - the full tempo map applies (renderMixdown assumed the first segment's
 *   tempo throughout).
 * The project mastering chain remains an export-only stage applied to the
 * bounced stereo, exactly as before (it is not audible live).
 *
 * Stems render through the same path: one extra engine pass per audible
 * track with every other lane muted, master strip/levels and the mastering
 * chain skipped (post-strip, pre-master). A stem therefore includes the
 * track's bus/send contributions.
 */

import { buildMidiClipSchedules } from '@/engine/midi-sync';
import { linearToDb } from '@/engine/mixer-sync';
import { busSceneJson, groupBusGainDb, stripSceneJson } from '@/engine/strip-sync';
import {
  MixdownCancelledError,
  type MixdownDeps,
  type MixdownRange,
  type MixdownRangePpq,
  type MixdownReport,
  type MixdownResult,
  type MixdownStem,
} from '@/export/mixdown';
import { ensureWasm } from '@/lib/wasm';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { automationCurveCode } from '@/project/automation';
import { audioClipSegments } from '@/project/comping';
import { loadFont } from '@/project/fonts';
import { DEFAULT_SYNTH_PRESET } from '@/project/instrument';
import { clampPan, masteringChainIsActive } from '@/project/mixer';
import {
  applyAudioClipFades,
  isTrackAudible,
  resampleChannelsLinear,
  sliceAudioClipWindow,
} from '@/project/scheduling';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap, ppqToSamples } from '@/project/tempo-map';
import type { EditorClip, EditorTrack } from '@/project/types';
import { bakeWarpedClip } from '@/project/warp';

/** Reserved engine mixer parameter namespace (mirrors the facade encoding). */
const ENGINE_MIXER_TARGET_BASE = 0x4d580000;
/** Lane byte addressing the master strip in the reserved namespace. */
const ENGINE_MIXER_LANE_MASTER = 0xff;
/** Parameter kind: lane/master fader gain in dB. */
const ENGINE_MIXER_PARAM_FADER_DB = 1;
/** Parameter kind: lane/master stereo pan in [-1, 1]. */
const ENGINE_MIXER_PARAM_PAN = 2;

/** Frames processed per offline block. */
const RENDER_BLOCK_FRAMES = 1024;

/** Blocks between progress/cancellation checkpoints (~0.7 s at 48 kHz). */
const BLOCKS_PER_CHECKPOINT = 32;

/** Release tail appended after the last clip for 'project' renders, in seconds. */
const RELEASE_TAIL_SECONDS = 2;

/**
 * Audible pre-roll rendered and discarded before the capture window, in
 * seconds. settleParameters snaps parameter smoothers, but stateful DSP
 * (dynamics envelopes, sidechain keys, reverb tails) only converges while
 * audio actually renders; without the pre-roll the first blocks of every
 * windowed render carry an audible transient (e.g. an unducked sidechain).
 */
const PREROLL_SECONDS = 0.5;

/** Tempo assumed when the document carries no tempo segment. */
const DEFAULT_TEMPO_BPM = 120;

/**
 * Minimal surface of the wasm RealtimeEngine used by the renderer. Kept
 * structural so tests can inject a fake engine.
 */
export interface OfflineRenderEngine {
  setTrackLanes(lanes: Array<{ trackId: number; sends?: SendSpec[] }>): void;
  setTrackBuses(buses: Array<{ busId: number; gainDb?: number }>): void;
  setTrackStripJson(trackId: number, sceneJson: string): void;
  setBusStripJson(busId: number, sceneJson: string): void;
  setMasterStripJson(sceneJson: string): void;
  setLaneSidechain(trackId: number, insertIndex: number, sourceTrackId: number): void;
  setTrackStripInsertBypassed(trackId: number, insertIndex: number, bypassed: boolean): void;
  setMasterStripInsertBypassed(insertIndex: number, bypassed: boolean): void;
  setTrackStripEqBandJson(trackId: number, bandIndex: number, bandJson: string): void;
  setMasterStripEqBandJson(bandIndex: number, bandJson: string): void;
  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void;
  setParameter(paramId: number, value: number): void;
  setAutomationLane(
    paramId: number,
    points: Array<{ ppq: number; value: number; curveToNext?: number }>,
  ): void;
  setTempoSegments(
    segments: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>,
  ): void;
  setClips(clips: EngineClipSpec[]): void;
  setMidiClips(clips: ReadonlyArray<unknown>): void;
  setSynthInstrument(patch?: object | string, destinationId?: number): void;
  loadSoundFont(data: Uint8Array): void;
  setSf2Instrument(config?: object, destinationId?: number): void;
  seekSample(timelineSample: number): void;
  settleParameters(): void;
  play(): void;
  stop(): void;
  process(channels: Float32Array[]): Float32Array[];
  destroy(): void;
}

/** One engine track send (numeric engine bus id). */
interface SendSpec {
  busId: number;
  levelDb?: number;
  enabled?: boolean;
}

/** One engine audio clip schedule (planar PCM at the render rate). */
interface EngineClipSpec {
  trackId: number;
  channels: Float32Array[];
  startPpq: number;
  lengthSamples: number;
  gain?: number;
}

/** Options for {@link renderProjectWithEngine}. */
export interface EngineRenderOptions {
  /** Output sample rate in Hz; defaults to the document sample rate. */
  sampleRate?: number;
  /** Render range (default 'project'). */
  range?: MixdownRange;
  /** Loop window used when range is 'loop'. */
  loopRegion?: MixdownRangePpq;
  /**
   * True (default) applies the master strip (inserts/EQ) and the project
   * mastering chain. False renders the raw engine mix (master gain/pan still
   * apply, as they are audible in live playback).
   */
  includeMasterChain?: boolean;
  /** True also returns one stereo stem per track (post-strip, pre-master). */
  stems?: boolean;
  /**
   * Renders ONE track's pre-fader signal in isolation (freeze/bounce-in-
   * place): every other lane is muted, the track's sends, fader/pan and
   * fader/pan automation are excluded (they stay live on the frozen track)
   * and master strip/levels are skipped. The result is the mixdown channels.
   */
  freezeTrackIndex?: number;
  /** Mastering/metering seams; undefined derives them from the wasm module. */
  deps?: Pick<MixdownDeps, 'mastering' | 'metering'> | null;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** SoundFont loader for 'sf2' instruments (defaults to the OPFS font store). */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Synth preset name resolver (defaults to identity). */
  resolvePreset?: (preset: string) => string;
  /** Progress callback: fraction in [0, 1] plus the stage being entered. */
  onProgress?: (progress: number, stage: string) => void;
  /** Cancellation flag, checked between render checkpoints. */
  shouldCancel?: () => boolean;
  /** Awaited between checkpoints so worker cancel messages are processed. */
  yieldBetweenBlocks?: () => Promise<void>;
  /** Engine factory override (tests); defaults to the wasm RealtimeEngine. */
  createEngine?: (sampleRate: number, blockSize: number) => OfflineRenderEngine;
}

/** Resolves the render window in PPQ; endPpq null = up to the content end. */
function resolveRange(options: EngineRenderOptions): { startPpq: number; endPpq: number | null } {
  const range = options.range ?? 'project';
  if (range === 'project') return { startPpq: 0, endPpq: null };
  const window = range === 'loop' ? options.loopRegion : range;
  if (range === 'loop' && !window) {
    throw new RangeError("Render range 'loop' requires options.loopRegion");
  }
  const { startPpq, endPpq } = window as MixdownRangePpq;
  if (!Number.isFinite(startPpq) || startPpq < 0 || !Number.isFinite(endPpq)) {
    throw new RangeError('Render range PPQ values must be finite and >= 0');
  }
  if (endPpq <= startPpq) {
    throw new RangeError(`Render range end (${endPpq}) must be after its start (${startPpq})`);
  }
  return { startPpq, endPpq };
}

/** Reserved engine parameter id for one lane parameter. */
function laneParamId(laneIndex: number, kind: number): number {
  return ENGINE_MIXER_TARGET_BASE | ((laneIndex & 0xff) << 8) | (kind & 0xff);
}

/** Reserved engine parameter id for one master strip parameter. */
function masterParamId(kind: number): number {
  return ENGINE_MIXER_TARGET_BASE | (ENGINE_MIXER_LANE_MASTER << 8) | (kind & 0xff);
}

/** What one engine pass renders. */
interface RenderPass {
  /** Apply the master strip scene (inserts/EQ). */
  masterStrip: boolean;
  /** Apply master gain/pan and master automation lanes. */
  masterLevels: boolean;
  /**
   * Non-null isolates these track indices (every other lane muted). A plain
   * track stem holds just its own index; a group stem holds the group and
   * its member indices so the submix renders through the group bus.
   */
  stemIndices: ReadonlySet<number> | null;
  /**
   * Non-null renders this track pre-fader (freeze): its sends are stripped,
   * its base fader/pan stay neutral and its fader/pan automation is skipped.
   */
  freezeIndex: number | null;
}

/**
 * Renders a project document to a stereo mixdown (and optional per-track
 * stems) through offline engine instances. See the module doc comment for
 * the relation to live playback.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Render options and injectable seams.
 * @returns The mixdown, its loudness/peak report and optional stems.
 * @throws MixdownCancelledError when options.shouldCancel returns true.
 */
export async function renderProjectWithEngine(
  doc: ProjectDocument,
  options: EngineRenderOptions = {},
): Promise<MixdownResult> {
  const sampleRate = options.sampleRate ?? doc.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Render sample rate must be finite and > 0, got ${sampleRate}`);
  }
  const includeMasterChain = options.includeMasterChain ?? true;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const loadFontBytes = options.loadFont ?? loadFont;
  const resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
  const checkCancel = () => {
    if (options.shouldCancel?.()) throw new MixdownCancelledError();
  };

  const tempoSegments =
    doc.tempoSegments.length > 0 ? doc.tempoSegments : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
  const tempoMap = normalizeTempoMap(tempoSegments);
  const sliceTempoBpm = tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  const range = resolveRange(options);

  let createEngine = options.createEngine;
  let deps = options.deps;
  if (!createEngine || deps === undefined) {
    const wasm = await ensureWasm();
    if (!createEngine) {
      createEngine = (rate, blockSize) =>
        new wasm.RealtimeEngine(rate, blockSize, 4096) as unknown as OfflineRenderEngine;
    }
    if (deps === undefined) {
      const { createWasmMixdownDeps } = await import('@/export/mixdown');
      deps = await createWasmMixdownDeps();
    }
  }

  options.onProgress?.(0, 'engine.prepare');

  // Synthetic numeric track ids: documents store tracks positionally.
  const trackIds = doc.tracks.map((_, index) => index + 1);

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
      gainDb: groupBusGainDb({
        volume: track.volume,
        mute: track.mute,
        ...(track.mixer !== undefined ? { mixer: track.mixer } : {}),
      } as Parameters<typeof groupBusGainDb>[0]),
    });
  });
  const lanes = doc.tracks.map((track, index) => {
    const sends: SendSpec[] = (track.mixer?.sends ?? [])
      .filter((send) => busNumberById.has(send.busId))
      .map((send) => ({
        busId: busNumberById.get(send.busId) as number,
        levelDb: send.levelDb,
        enabled: send.enabled,
      }));
    const groupBus =
      track.groupIndex !== undefined ? groupBusByTrackIndex.get(track.groupIndex) : undefined;
    return {
      trackId: trackIds[index],
      ...(sends.length > 0 ? { sends } : {}),
      ...(groupBus !== undefined ? { outputBusId: groupBus } : {}),
    };
  });

  // Pre-load instrument fonts once; engine passes then configure synchronously.
  const fontBytesById = new Map<string, Uint8Array>();
  for (const track of doc.tracks) {
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

  // MIDI clip schedules via the live builder (velocity-folded clip gain,
  // SF2 preludes, tempo-map-exact sample positions).
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
      });
    });
  });
  const midiSchedules =
    midiClips.length > 0
      ? buildMidiClipSchedules(midiTracks, midiClips, tempoSegments, sampleRate)
      : [];

  // Audio clips: the live scheduling transforms (slice window, baked fades,
  // linear resample to the render rate), placed at their timeline PPQ.
  const audioClips: EngineClipSpec[] = [];
  const renderAudioClip = async (clip: DocumentClip, trackId: number): Promise<void> => {
    if (clip.gain <= 0) return;
    // A clip expands to one engine clip per comp segment (one segment for
    // clips without takes), matching live scheduling exactly.
    for (const segment of audioClipSegments(clip)) {
      let asset: LoadedAudioAsset;
      try {
        asset = await loadAudio(segment.assetId);
      } catch {
        // Missing or unreadable asset: leave the slice silent, like live playback.
        continue;
      }
      // Tempo-following clips bake their window through the offline stretch
      // instead of the fixed-rate slice (takes-free clips only).
      let channels =
        clip.warp?.enabled && (clip.takes?.length ?? 0) === 0
          ? await bakeWarpedClip(asset.channels, asset.meta.sampleRate, clip, sliceTempoBpm, {
              cacheKey: segment.assetId,
            })
          : sliceAudioClipWindow(
              asset.channels,
              asset.meta.sampleRate,
              segment.sourceOffsetPpq,
              segment.lengthPpq,
              sliceTempoBpm,
            );
      channels = applyAudioClipFades(
        channels,
        asset.meta.sampleRate,
        sliceTempoBpm,
        segment.fadeInPpq,
        segment.fadeOutPpq,
      );
      channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
      if (channels.length === 0 || channels[0].length === 0) continue;
      audioClips.push({
        trackId,
        channels,
        startPpq: clip.startPpq + segment.offsetPpq,
        lengthSamples: channels[0].length,
        gain: clip.gain,
      });
    }
  };
  for (let index = 0; index < doc.tracks.length; index++) {
    const track = doc.tracks[index];
    // Frozen tracks play their baked pre-fader render from the timeline
    // start instead of their own clips.
    if (track.frozen !== undefined) {
      try {
        const asset = await loadAudio(track.frozen.assetId);
        const channels = resampleChannelsLinear(
          asset.channels.map((channel) => channel.slice()),
          asset.meta.sampleRate,
          sampleRate,
        );
        if (channels.length > 0 && channels[0].length > 0) {
          audioClips.push({
            trackId: trackIds[index],
            channels,
            startPpq: 0,
            lengthSamples: channels[0].length,
            gain: 1,
          });
        }
      } catch {
        // Missing or unreadable frozen asset: the track stays silent.
      }
      continue;
    }
    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') !== 'audio') continue;
      checkCancel();
      await renderAudioClip(clip, trackIds[index]);
    }
  }

  // Resolve the render window in frames.
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
      Math.round(RELEASE_TAIL_SECONDS * sampleRate);
  }
  const totalFrames = Math.max(0, endSample - startSample);

  /** Replays the pre-built program onto a fresh engine (synchronous). */
  const configureEngine = (engine: OfflineRenderEngine, pass: RenderPass): void => {
    // The engine validates sends against already-declared buses, so the bus
    // set must be installed before any lane that carries sends. A freeze
    // pass strips the frozen lane's sends (they stay live on the track).
    if (buses.length > 0) engine.setTrackBuses(buses);
    engine.setTrackLanes(
      pass.freezeIndex === null
        ? lanes
        : lanes.map((lane, index) =>
            index === pass.freezeIndex ? { trackId: lane.trackId } : lane,
          ),
    );

    // Per-track strips (inserts + EQ + bypass flags), lane base fader/pan and
    // solo/mute — the same state the live mixer/strip syncs install. A stem
    // pass instead isolates one lane by muting every other one (solo would
    // also keep the document's own soloed tracks audible).
    doc.tracks.forEach((track, index) => {
      const strip = track.mixer;
      const trackId = trackIds[index];
      if (track.kind === 'group') {
        // Group inserts ride the group's bus strip (the lane stays silent);
        // the audible group level was already baked into the bus gain.
        const busId = groupBusByTrackIndex.get(index);
        const enabledInserts = (strip?.inserts ?? []).filter((slot) => slot.enabled);
        if (busId !== undefined && enabledInserts.length > 0) {
          engine.setBusStripJson(
            busId,
            busSceneJson(busId, { ...(strip as object), inserts: enabledInserts } as NonNullable<
              typeof strip
            >),
          );
        }
        return;
      }
      if (track.frozen === undefined && strip && (strip.inserts.length > 0 || strip.eq)) {
        // Frozen tracks bypass their strip DSP (baked into the render).
        engine.setTrackStripJson(trackId, stripSceneJson(trackId, strip));
        strip.inserts.forEach((slot, insertIndex) => {
          if (!slot.enabled) engine.setTrackStripInsertBypassed(trackId, insertIndex, true);
        });
        strip.eq?.bands.forEach((band, bandIndex) => {
          engine.setTrackStripEqBandJson(trackId, bandIndex, JSON.stringify(band));
        });
      }
      if (pass.stemIndices === null) {
        engine.setSoloMute(index, track.solo, track.mute);
      } else {
        engine.setSoloMute(index, false, !pass.stemIndices.has(index));
      }
      if (pass.freezeIndex === index) {
        // Pre-fader freeze: the lane renders at unity/centered; the live
        // fader/pan keep applying to the baked audio afterwards.
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB), 0);
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), 0);
      } else {
        engine.setParameter(
          laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB),
          linearToDb(track.volume) + (strip?.gainDb ?? 0),
        );
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), clampPan(strip?.pan ?? 0));
      }
    });

    // Insert sidechain keys (document inserts carry positional sources).
    doc.tracks.forEach((track, index) => {
      if (track.kind === 'group') return;
      (track.mixer?.inserts ?? []).forEach((slot, insertIndex) => {
        const sourceIndex = (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
        if (
          sourceIndex === undefined ||
          !Number.isInteger(sourceIndex) ||
          sourceIndex < 0 ||
          sourceIndex >= doc.tracks.length ||
          sourceIndex === index
        ) {
          return;
        }
        engine.setLaneSidechain(trackIds[index], insertIndex, trackIds[sourceIndex]);
      });
    });

    // Master strip: inserts/EQ only with the chain enabled; gain/pan whenever
    // the pass renders master levels (stems are pre-master).
    const master = doc.mixer?.master;
    if (pass.masterStrip && master && (master.inserts.length > 0 || master.eq)) {
      engine.setMasterStripJson(stripSceneJson('master', master));
      master.inserts.forEach((slot, insertIndex) => {
        if (!slot.enabled) engine.setMasterStripInsertBypassed(insertIndex, true);
      });
      master.eq?.bands.forEach((band, bandIndex) => {
        engine.setMasterStripEqBandJson(bandIndex, JSON.stringify(band));
      });
    }
    if (pass.masterLevels) {
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_FADER_DB), master?.gainDb ?? 0);
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_PAN), clampPan(master?.pan ?? 0));
    }

    // Automation lanes (track entries + master), enabled lanes only.
    doc.tracks.forEach((track, index) => {
      if (pass.freezeIndex === index) return;
      for (const lane of track.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(
          laneParamId(index, kind),
          lane.points.map((point) => ({
            ppq: point.ppq,
            value: point.value,
            curveToNext: automationCurveCode(point.curve),
          })),
        );
      }
    });
    if (pass.masterLevels) {
      for (const lane of doc.masterAutomation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(
          masterParamId(kind),
          lane.points.map((point) => ({
            ppq: point.ppq,
            value: point.value,
            curveToNext: automationCurveCode(point.curve),
          })),
        );
      }
    }

    engine.setTempoSegments(
      tempoSegments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
    );

    // Instruments for MIDI tracks: same resolution as the live midi-sync
    // (default preset when absent; one global SoundFont, last font wins).
    let loadedFontId: string | undefined;
    for (let index = 0; index < doc.tracks.length; index++) {
      const track = doc.tracks[index];
      if (track.kind !== 'midi') continue;
      const instrument = track.instrument;
      const destinationId = trackIds[index];
      if (instrument === undefined) {
        engine.setSynthInstrument(resolvePreset(DEFAULT_SYNTH_PRESET), destinationId);
      } else if (instrument.kind === 'synth-preset') {
        engine.setSynthInstrument(resolvePreset(instrument.preset), destinationId);
      } else if (instrument.kind === 'synth-patch') {
        engine.setSynthInstrument(instrument.patch as Record<string, unknown>, destinationId);
      } else {
        const bytes = fontBytesById.get(instrument.fontId);
        if (bytes && instrument.fontId !== loadedFontId) {
          engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        engine.setSf2Instrument({}, destinationId);
      }
    }

    if (midiSchedules.length > 0) engine.setMidiClips(midiSchedules);
    if (audioClips.length > 0) engine.setClips(audioClips);
  };

  /**
   * Drives one engine pass block by block over the render window, mapping its
   * progress onto [progressStart, progressStart + progressSpan]. Lane faders
   * and other engine parameters are smoothed, so a freshly built engine would
   * ramp them in from their defaults over the first audible milliseconds. One
   * priming block with the transport stopped (drains queued commands and
   * applies automation at the seek position, nothing sounds) followed by
   * settleParameters snaps every smoother to its target before play.
   */
  const renderWindow = async (
    engine: OfflineRenderEngine,
    stage: string,
    progressStart: number,
    progressSpan: number,
  ): Promise<[Float32Array, Float32Array]> => {
    const left = new Float32Array(totalFrames);
    const right = new Float32Array(totalFrames);
    // Roll (and discard) a pre-roll up to the window start so stateful DSP
    // and the content before the window (sustained clips, sidechain keys)
    // are already in motion when capture begins. Renders from the timeline
    // start have nothing before them and start cold by definition.
    const prerollFrames = Math.min(startSample, Math.round(PREROLL_SECONDS * sampleRate));
    engine.seekSample(startSample - prerollFrames);
    engine.process([new Float32Array(RENDER_BLOCK_FRAMES), new Float32Array(RENDER_BLOCK_FRAMES)]);
    engine.settleParameters();
    engine.play();
    let prerollDone = 0;
    while (prerollDone < prerollFrames) {
      const blockFrames = Math.min(RENDER_BLOCK_FRAMES, prerollFrames - prerollDone);
      engine.process([new Float32Array(blockFrames), new Float32Array(blockFrames)]);
      prerollDone += blockFrames;
    }
    let framesDone = 0;
    let blocksSinceCheckpoint = 0;
    while (framesDone < totalFrames) {
      const blockFrames = Math.min(RENDER_BLOCK_FRAMES, totalFrames - framesDone);
      const out = engine.process([new Float32Array(blockFrames), new Float32Array(blockFrames)]);
      left.set(out[0].subarray(0, blockFrames), framesDone);
      right.set((out[1] ?? out[0]).subarray(0, blockFrames), framesDone);
      framesDone += blockFrames;
      if (++blocksSinceCheckpoint >= BLOCKS_PER_CHECKPOINT) {
        blocksSinceCheckpoint = 0;
        checkCancel();
        options.onProgress?.(
          progressStart + (framesDone / Math.max(1, totalFrames)) * progressSpan,
          stage,
        );
        if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks();
      }
    }
    engine.stop();
    return [left, right];
  };

  /** Runs one configured pass on a fresh engine, destroying it afterwards. */
  const runPass = async (
    pass: RenderPass,
    stage: string,
    progressStart: number,
    progressSpan: number,
  ): Promise<[Float32Array, Float32Array]> => {
    const engine = (createEngine as NonNullable<typeof createEngine>)(
      sampleRate,
      RENDER_BLOCK_FRAMES,
    );
    try {
      configureEngine(engine, pass);
      return await renderWindow(engine, stage, progressStart, progressSpan);
    } finally {
      engine.destroy();
    }
  };

  // A freeze render is a single isolated pre-fader pass; everything else
  // renders the mix (and optional stems).
  if (options.freezeTrackIndex !== undefined) {
    const freezeIndex = options.freezeTrackIndex;
    if (!Number.isInteger(freezeIndex) || freezeIndex < 0 || freezeIndex >= doc.tracks.length) {
      throw new RangeError(`Freeze track index ${freezeIndex} is out of range`);
    }
    const channels = await runPass(
      {
        masterStrip: false,
        masterLevels: false,
        stemIndices: new Set([freezeIndex]),
        freezeIndex,
      },
      'engine.freeze',
      0,
      0.9,
    );
    options.onProgress?.(1, 'done');
    let freezePeak = 0;
    for (const channel of channels) {
      for (const value of channel) {
        const magnitude = Math.abs(value);
        if (magnitude > freezePeak) freezePeak = magnitude;
      }
    }
    return {
      channels,
      sampleRate,
      totalFrames,
      report: {
        peakDb: freezePeak > 0 ? 20 * Math.log10(freezePeak) : Number.NEGATIVE_INFINITY,
      },
    };
  }

  // Pass schedule: the mix, then one isolated pass per audible track.
  const stemTracks = options.stems
    ? doc.tracks
        .map((track, trackIndex) => ({ track, trackIndex }))
        .filter(({ track }) => isTrackAudible(track, doc.tracks))
    : [];
  const passSpan = 0.9 / (1 + stemTracks.length);

  let [mixL, mixR] = await runPass(
    { masterStrip: includeMasterChain, masterLevels: true, stemIndices: null, freezeIndex: null },
    'engine.render',
    0,
    passSpan,
  );

  const stems: MixdownStem[] = [];
  for (let i = 0; i < stemTracks.length; i++) {
    const { track, trackIndex } = stemTracks[i];
    checkCancel();
    // A group stem keeps its member lanes audible (their output routes
    // through the group bus), so it renders the group submix.
    const stemIndices = new Set<number>([trackIndex]);
    if (track.kind === 'group') {
      doc.tracks.forEach((member, memberIndex) => {
        if (member.groupIndex === trackIndex) stemIndices.add(memberIndex);
      });
    }
    const channels = await runPass(
      { masterStrip: false, masterLevels: false, stemIndices, freezeIndex: null },
      `engine.stem:${trackIndex}`,
      passSpan * (1 + i),
      passSpan,
    );
    stems.push({ trackIndex, name: track.name, channels });
  }

  // Mastering chain: export-only stage on the bounced stereo, as before.
  const chain = doc.mixer?.masteringChain;
  const mastering = deps?.mastering ?? null;
  if (includeMasterChain && chain && masteringChainIsActive(chain) && mastering) {
    if (chain.preset !== undefined && mastering.applyPreset) {
      checkCancel();
      options.onProgress?.(0.92, `mastering.preset:${chain.preset}`);
      const out = mastering.applyPreset(chain.preset, mixL, mixR, sampleRate);
      mixL = out.left;
      mixR = out.right;
    }
    for (const slot of chain.processors) {
      if (!slot.enabled) continue;
      checkCancel();
      options.onProgress?.(0.94, `mastering.${slot.processor}`);
      const out = mastering.processStereo(slot.processor, mixL, mixR, sampleRate, slot.params);
      mixL = out.left;
      mixR = out.right;
    }
  }

  // Loudness/peak report (same shape as renderMixdown).
  checkCancel();
  options.onProgress?.(0.97, 'metering');
  let peak = 0;
  for (let i = 0; i < mixL.length; i++) {
    const a = Math.abs(mixL[i]);
    const b = Math.abs(mixR[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const report: MixdownReport = {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
  };
  const metering = deps?.metering ?? null;
  if (metering?.truePeakDb && totalFrames > 0) {
    try {
      report.truePeakDb = Math.max(
        metering.truePeakDb(mixL, sampleRate),
        metering.truePeakDb(mixR, sampleRate),
      );
    } catch {
      // True peak stays absent when the metering call fails.
    }
  }
  if (metering?.integratedLufs && totalFrames > 0) {
    try {
      const mono = new Float32Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) mono[i] = 0.5 * (mixL[i] + mixR[i]);
      report.lufs = metering.integratedLufs(mono, sampleRate);
    } catch {
      // Loudness stays absent when the metering call fails.
    }
  }
  options.onProgress?.(1, 'done');

  const result: MixdownResult = { channels: [mixL, mixR], sampleRate, totalFrames, report };
  if (options.stems) result.stems = stems;
  return result;
}

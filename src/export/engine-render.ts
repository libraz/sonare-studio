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
 *
 * Setup builders (bus routing, SoundFont preload, MIDI program, audio clips,
 * render window) live in engine-render-context.ts / engine-render-clips.ts;
 * shared types/constants in engine-render-types.ts and the loudness/peak
 * report in engine-render-report.ts. This module is the orchestrator: it
 * configures and drives the engine passes and re-exports the public surface.
 */

import { engineAutomationPoints, engineBusStrip, engineEqBands } from '@/engine/engine-declaration';
import { resolvePresetName } from '@/engine/instruments';
import { busSceneJson, stripSceneJson } from '@/engine/strip-sync';
import {
  MixdownCancelledError,
  type MixdownReport,
  type MixdownResult,
  type MixdownStem,
} from '@/export/mixdown';
import { peakDb } from '@/lib/db';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { parseInsertAutomationParam } from '@/project/automation';
import { enabledInsertAutomationIndex } from '@/project/automation-insert';
import { loadFont } from '@/project/fonts';
import { DEFAULT_SYNTH_PRESET, sf2PlaybackConfig } from '@/project/instrument';
import { midiFxConfigJson } from '@/project/midi-fx';
import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  laneGainDb,
  masteringChainIsActive,
  stripHasDsp,
  vcaOffsetDb,
} from '@/project/mixer';
import { isTrackAudible } from '@/project/scheduling';
import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';
import { buildAudioClips } from './engine-render-clips';
import {
  buildBusRouting,
  buildMidiSchedules,
  preloadSoundFonts,
  resolveRenderWindow,
} from './engine-render-context';
import { buildReport } from './engine-render-report';
import {
  BLOCKS_PER_CHECKPOINT,
  busParamId,
  DEFAULT_TEMPO_BPM,
  ENGINE_MIXER_PARAM_FADER_DB,
  ENGINE_MIXER_PARAM_PAN,
  type EngineRenderOptions,
  laneParamId,
  masterParamId,
  type OfflineRenderEngine,
  PREROLL_SECONDS,
  RENDER_BLOCK_FRAMES,
  type RenderPass,
  resolveRange,
} from './engine-render-types';

export type { EngineRenderOptions, OfflineRenderEngine } from './engine-render-types';

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
  let resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
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
    if (!options.resolvePreset) {
      resolvePreset = (preset: string) => resolvePresetName(wasm, preset);
    }
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

  // Bus/send routing, VCA offsets, solo state and lane specs (live strip-sync
  // ordering: send buses first, then one bus per group track).
  const { vcaGainDbById, anySolo, busNumberById, buses, groupBusByTrackIndex, lanes } =
    buildBusRouting(doc, trackIds);

  // Pre-load instrument fonts once; engine passes then configure synchronously.
  const fontBytesById = await preloadSoundFonts(doc, loadFontBytes);

  // MIDI clip schedules via the live builder (velocity-folded clip gain,
  // SF2 preludes, tempo-map-exact sample positions).
  const midiSchedules = buildMidiSchedules(doc, trackIds, tempoSegments, sampleRate);

  // Audio clips: the live scheduling transforms (slice window, baked fades,
  // linear resample to the render rate), placed at their timeline PPQ.
  const audioClips = await buildAudioClips(doc, {
    trackIds,
    sliceTempoBpm,
    tempoMap,
    sampleRate,
    loadAudio,
    checkCancel,
  });

  // Resolve the render window in frames.
  const { startSample, totalFrames } = resolveRenderWindow(
    doc,
    tempoMap,
    range,
    sampleRate,
    options.releaseTailSeconds,
  );

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

    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      if (!stripHasDsp(bus.strip)) continue;
      engine.setBusStripJson(busId, busSceneJson(busId, engineBusStrip(bus.strip)));
    }

    // Per-track strips (inserts + EQ + bypass flags), lane base fader/pan and
    // solo/mute — the same state the live mixer/strip syncs install. A stem
    // pass instead isolates one lane by muting every other one (solo would
    // also keep the document's own soloed tracks audible).
    const soloedGroupTrackIndices = new Set(
      doc.tracks
        .map((track, index) => (track.kind === 'group' && track.solo ? index : -1))
        .filter((index) => index >= 0),
    );
    doc.tracks.forEach((track, index) => {
      const strip = track.mixer;
      const trackId = trackIds[index];
      if (track.kind === 'group') {
        // Group inserts ride the group's bus strip (the lane stays silent);
        // the audible group level was already baked into the bus gain.
        const busId = groupBusByTrackIndex.get(index);
        if (busId !== undefined && stripHasDsp(strip)) {
          engine.setBusStripJson(busId, busSceneJson(busId, engineBusStrip(strip)));
        }
        return;
      }
      if (track.frozen === undefined && strip && stripHasDsp(strip)) {
        // Frozen tracks bypass their strip DSP (baked into the render).
        engine.setTrackStripJson(trackId, stripSceneJson(trackId, strip));
        strip.inserts.forEach((slot, insertIndex) => {
          if (!slot.enabled) engine.setTrackStripInsertBypassed(trackId, insertIndex, true);
        });
        engineEqBands(strip).forEach((band, bandIndex) => {
          engine.setTrackStripEqBandJson(trackId, bandIndex, JSON.stringify(band));
        });
      }
      if (pass.stemIndices === null) {
        // Solo-safe lanes stay in the solo group while any solo is active.
        const solo =
          track.solo ||
          (track.groupIndex !== undefined && soloedGroupTrackIndices.has(track.groupIndex)) ||
          (anySolo && track.soloSafe === true);
        engine.setSoloMute(index, solo, track.mute);
      } else {
        engine.setSoloMute(index, false, !pass.stemIndices.has(index));
      }
      if (pass.freezeIndex === index) {
        // Pre-fader freeze: the lane renders at unity/centered with neutral pan
        // shaping; the live fader/pan/pan-law keep applying to the baked audio.
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB), 0);
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), 0);
      } else {
        // Lane fader includes the strip trim and the track's VCA group offset,
        // so a VCA-attenuated track exports at the level it plays back at.
        engine.setParameter(
          laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB),
          laneGainDb(track.volume, strip?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDbById)),
        );
        const pan = clampPan(strip?.pan ?? 0);
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), pan);
        // Pan law / mode / dual-pan / channel-delay shape the lane exactly as
        // live mixer-sync does; emit only the non-defaults to keep the command
        // budget small (the engine starts each lane at these defaults).
        const panLaw = strip?.panLaw ?? DEFAULT_PAN_LAW;
        if (panLaw !== DEFAULT_PAN_LAW) engine.setTrackStripPanLaw(trackId, panLaw);
        const panMode = strip?.panMode ?? DEFAULT_PAN_MODE;
        if (panMode !== DEFAULT_PAN_MODE) engine.setTrackStripPanMode(trackId, panMode);
        if (strip?.dualPan) {
          engine.setTrackStripDualPan(
            trackId,
            clampPan(strip.dualPan.left),
            clampPan(strip.dualPan.right),
          );
        }
        const channelDelay = Math.max(0, Math.round(strip?.channelDelaySamples ?? 0));
        if (channelDelay > 0) engine.setTrackStripChannelDelaySamples(trackId, channelDelay);
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
    if (pass.masterStrip && master && stripHasDsp(master)) {
      engine.setMasterStripJson(stripSceneJson('master', master));
      master.inserts.forEach((slot, insertIndex) => {
        if (!slot.enabled) engine.setMasterStripInsertBypassed(insertIndex, true);
      });
      engineEqBands(master).forEach((band, bandIndex) => {
        engine.setMasterStripEqBandJson(bandIndex, JSON.stringify(band));
      });
    }
    if (pass.masterLevels) {
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_FADER_DB), master?.gainDb ?? 0);
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_PAN), clampPan(master?.pan ?? 0));
    }

    // Automation lanes (track entries + master), enabled lanes only.
    doc.tracks.forEach((track, index) => {
      for (const lane of track.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        if (pass.freezeIndex === index && (lane.param === 'faderDb' || lane.param === 'pan')) {
          continue;
        }
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        // Insert-parameter lanes resolve to the engine's reserved insert id
        // (and strip selector) from the strip state already installed above; a
        // negative id means the insert or key is unknown and is skipped.
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
          if (groupBusId !== undefined) {
            const insertIndex = enabledInsertAutomationIndex(track.mixer, insertRef.insertIndex);
            if (insertIndex === undefined) continue;
            const id = engine.resolveBusInsertAutomationId(
              groupBusId,
              insertIndex,
              insertRef.paramName,
            );
            if (id >= 0) engine.setAutomationLane(id, points);
            continue;
          }
          const id = engine.resolveTrackInsertAutomationId(
            trackIds[index],
            insertRef.insertIndex,
            insertRef.paramName,
          );
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
        if (groupBusId !== undefined) {
          if (lane.param === 'faderDb') engine.setAutomationLane(busParamId(groupBusId), points);
          continue;
        }
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(laneParamId(index, kind), points);
      }
    });
    if (pass.masterLevels) {
      for (const lane of doc.masterAutomation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const id = engine.resolveMasterInsertAutomationId(
            insertRef.insertIndex,
            insertRef.paramName,
          );
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(masterParamId(kind), points);
      }
    }
    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      for (const lane of bus.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const insertIndex = enabledInsertAutomationIndex(bus?.strip, insertRef.insertIndex);
          if (insertIndex === undefined) continue;
          const id = engine.resolveBusInsertAutomationId(busId, insertIndex, insertRef.paramName);
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        if (lane.param !== 'faderDb') continue;
        engine.setAutomationLane(busParamId(busId), points);
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
      if (track.frozen !== undefined) continue;
      const instrument = track.instrument;
      const destinationId = trackIds[index];
      if (instrument === undefined) {
        engine.setSynthInstrument(resolvePreset(DEFAULT_SYNTH_PRESET), destinationId);
      } else if (instrument.kind === 'synth-preset') {
        engine.setSynthInstrument(resolvePreset(instrument.preset), destinationId);
      } else if (instrument.kind === 'synth-patch') {
        engine.setSynthInstrument(instrument.patch as Record<string, unknown>, destinationId);
      } else if (instrument.kind === 'sf2') {
        const bytes = fontBytesById.get(instrument.fontId);
        if (bytes && instrument.fontId !== loadedFontId) {
          engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        engine.setSf2Instrument(sf2PlaybackConfig(instrument), destinationId);
      }
      // External-MIDI tracks have no internal instrument and no external device
      // during an offline render, so they bind nothing here and stay silent.
      // Apply the track's live, non-destructive MIDI-FX insert so the export
      // matches live playback (the same engine transform, applied here rather
      // than baked into the notes).
      if (track.midiFx !== undefined) {
        const json = midiFxConfigJson(track.midiFx);
        if (json !== null) engine.setMidiFx(destinationId, json);
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
    if (doc.tracks[freezeIndex].kind === 'group') {
      throw new RangeError('Group tracks cannot be frozen');
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
        peakDb: peakDb(freezePeak),
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
        if (member.groupIndex === trackIndex && !member.mute) stemIndices.add(memberIndex);
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
  const report: MixdownReport = buildReport(
    mixL,
    mixR,
    sampleRate,
    totalFrames,
    deps?.metering ?? null,
  );
  options.onProgress?.(1, 'done');

  const result: MixdownResult = { channels: [mixL, mixR], sampleRate, totalFrames, report };
  if (options.stems) result.stems = stems;
  return result;
}

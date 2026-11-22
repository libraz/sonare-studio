/**
 * Replays a pre-built render program onto offline engines: the factory that
 * turns the orchestrator's resolved document state into the per-pass installer.
 */

import type { SidechainSource } from '@libraz/libsonare';
import { resolveAutomationId } from '@/engine/automation-ids';
import {
  ENGINE_DEFAULT_PAN_LAW,
  ENGINE_DEFAULT_PAN_MODE,
  engineAutomationPoints,
  engineBusInsertAutomationIndex,
  engineBusPanState,
  engineBusStripHasDsp,
  engineEqBands,
  engineFaderAutomationPoints,
  enginePannerNeedsStrip,
} from '@/engine/engine-declaration';
import {
  type GsSysExDestination,
  MAX_REALTIME_SYSEX_BYTES,
  pushGsSetupSysex,
} from '@/engine/gs-sysex';
import { busScene, stripScene } from '@/engine/strip-sync';
import type { PagedClipSpec } from '@/export/clip-page-stream';
import {
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import type { createInsertPdcPlan } from '@/project/insert-latency';
import {
  type effectiveTrackInstrument,
  isNativeSynthInstrument,
  sf2PlaybackConfig,
} from '@/project/instrument';
import { midiFxConfig } from '@/project/midi-fx';
import {
  assertCanAddTracks,
  clampPan,
  effectiveTrackMute,
  laneGainDb,
  type MixerStrip,
  type returnSoloRouting,
  stripHasDsp,
  type tracksWithVcaSolo,
  vcaOffsetDb,
} from '@/project/mixer';
import { DEFAULT_WARP_VOICES, expandedSoloStates, MAX_WARP_VOICES } from '@/project/scheduling';
import type { ProjectDocument } from '@/project/serialization';
import type { BusRouting } from './engine-render-context';
import {
  busFaderParamId,
  type EngineClipSpec,
  masterParamId,
  type OfflineRenderEngine,
  type RenderPass,
  trackLaneParamId,
} from './engine-render-types';
import type { documentTempoSegments, ExportRenderPlan } from './render-plan';

/** Resolved document state the per-pass installer replays onto an engine. */
export interface RenderProgram {
  doc: ProjectDocument;
  trackIds: number[];
  /** The whole bus/send routing result. */
  routing: BusRouting;
  tracksForSolo: ReturnType<typeof tracksWithVcaSolo<ProjectDocument['tracks'][number]>>;
  conflictingSf2TrackIndices: ReadonlySet<number>;
  pdc: ReturnType<typeof createInsertPdcPlan>;
  pdcTracks: Parameters<ReturnType<typeof createInsertPdcPlan>['delayFor']>[0][];
  returnSolo: ReturnType<typeof returnSoloRouting>;
  tempoSegments: ReturnType<typeof documentTempoSegments>;
  resolvePreset: (preset: string) => string;
  effectiveInstruments: (ReturnType<typeof effectiveTrackInstrument> | undefined)[];
  fontBytesById: ReadonlyMap<string, Uint8Array>;
  midiSchedules: ExportRenderPlan['midiSchedules'];
  /** Current audio clips; read per install because the list is replaced after SF2 bounces. */
  audioClips: () => EngineClipSpec[];
}

/**
 * Builds the installer that replays `program` onto a fresh engine for one pass.
 * The unsupported-SysEx warning latches once per installer.
 */
export function createProgramInstaller(
  program: RenderProgram,
): (
  engine: OfflineRenderEngine,
  pass: RenderPass,
  pagedClips?: ReadonlyArray<PagedClipSpec>,
  includeClips?: boolean,
) => void {
  const {
    doc,
    trackIds,
    tracksForSolo,
    conflictingSf2TrackIndices,
    pdc,
    pdcTracks,
    returnSolo,
    tempoSegments,
    resolvePreset,
    effectiveInstruments,
    fontBytesById,
    midiSchedules,
  } = program;
  const {
    vcaGainDbById,
    vcaControlsById,
    busNumberById,
    buses,
    groupBusByTrackIndex,
    lanes,
    discardBusId,
  } = program.routing;
  const documentSoloExpansion = {
    isGroup: (track: ProjectDocument['tracks'][number]) => track.kind === 'group',
    groupKey: (_track: ProjectDocument['tracks'][number], index: number) => index,
    memberGroupKey: (track: ProjectDocument['tracks'][number]) => track.groupIndex,
  };
  let warnedUnsupportedGsSysex = false;

  /**
   * Replays the pre-built program onto a fresh engine (synchronous).
   *
   * @returns The MIDI schedules this pass plays.
   */
  return (
    engine: OfflineRenderEngine,
    pass: RenderPass,
    pagedClips: ReadonlyArray<PagedClipSpec> = [],
    includeClips = true,
  ): void => {
    const renderAudioClips = program.audioClips();
    // Every 2.0 engine declares bus EQ and per-insert bypass.
    const supportsBusEq = true;
    const supportsBusInsertBypass = true;
    // The engine validates sends against already-declared buses, so the bus
    // set must be installed before any lane that carries sends. A freeze pass
    // strips the frozen lane's sends (they stay live on the track). A bus stem
    // pass adds a silent discard bus so non-selected direct outputs can be
    // removed while selected sends/outputs still feed the return.
    const silentBusId =
      pass.busStemId === null
        ? null
        : (discardBusId ?? buses.reduce((max, bus) => Math.max(max, bus.busId), 0) + 1);
    const passBuses =
      silentBusId === null || discardBusId === silentBusId
        ? buses
        : [...buses, { busId: silentBusId, gainDb: -120 }];
    if (passBuses.length > 0) engine.setTrackBuses(passBuses);
    // A muted lane can still feed a pre-fader send: libsonare taps it before
    // the lane's mute/solo gate. An isolated render must remove sends from
    // every non-selected lane while retaining its lane for sidechain state.
    const isolatedLanes =
      pass.stemIndices === null
        ? lanes
        : lanes.map((lane, index) =>
            pass.stemIndices?.has(index) ? lane : { trackId: lane.trackId },
          );
    const passLanes =
      pass.freezeIndex !== null
        ? isolatedLanes.map((lane, index) =>
            index === pass.freezeIndex ? { trackId: lane.trackId } : lane,
          )
        : pass.busStemId !== null && silentBusId !== null
          ? isolatedLanes.map((lane) => {
              const sends = lane.sends?.filter((send) => send.busId === pass.busStemId) ?? [];
              const outputBusId =
                lane.outputBusId === pass.busStemId ? pass.busStemId : silentBusId;
              return {
                trackId: lane.trackId,
                ...(sends.length > 0 ? { sends } : {}),
                outputBusId,
              };
            })
          : pass.stemIndices !== null && pass.stemRouting !== 'document'
            ? isolatedLanes.map((lane, index) => {
                if (!pass.stemIndices?.has(index)) return lane;
                return {
                  trackId: lane.trackId,
                  ...(!pass.separateReturnStems && lane.sends?.length ? { sends: lane.sends } : {}),
                  ...(pass.stemRouting === 'group' && lane.outputBusId !== undefined
                    ? { outputBusId: lane.outputBusId }
                    : {}),
                };
              })
            : isolatedLanes;
    assertCanAddTracks(0, passLanes.length);
    engine.setTrackLanes(passLanes);

    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      if (!engineBusStripHasDsp(bus.strip, supportsBusEq)) continue;
      engine.setBusStrip(
        busId,
        busScene(busId, bus.strip, undefined, {
          includeEq: supportsBusEq,
          channelLayout: bus.channelLayout,
        }),
      );
      bus.strip?.inserts.forEach((slot, insertIndex) => {
        engine.setBusInsertBypassed(busId, insertIndex, { bypassed: !slot.enabled });
      });
      engineEqBands(bus.strip).forEach((band, bandIndex) => {
        engine.setBusEqBand(busId, bandIndex, band);
      });
    }

    // Per-track strips (inserts + EQ + bypass flags), lane base fader/pan and
    // solo/mute — the same state the live mixer/strip syncs install. A stem
    // pass instead isolates one lane by muting every other one (solo would
    // also keep the document's own soloed tracks audible).
    const soloStates = expandedSoloStates(tracksForSolo, documentSoloExpansion);
    doc.tracks.forEach((track, index) => {
      const strip = track.mixer;
      const trackId = trackIds[index];
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      if (track.kind === 'group') {
        // Group inserts ride the group's bus strip (the lane stays silent);
        // the audible group level was already baked into the bus gain.
        const busId = groupBusByTrackIndex.get(index);
        if (busId !== undefined && engineBusStripHasDsp(strip, supportsBusEq)) {
          engine.setBusStrip(
            busId,
            busScene(busId, strip, undefined, { includeEq: supportsBusEq }),
          );
          strip?.inserts.forEach((slot, insertIndex) => {
            engine.setBusInsertBypassed(busId, insertIndex, { bypassed: !slot.enabled });
          });
          engineEqBands(strip).forEach((band, bandIndex) => {
            engine.setBusEqBand(busId, bandIndex, band);
          });
        }
        return;
      }
      // A channel-delay target must already have a strip in libsonare. Keep
      // the declaration decision separate from the store strip: frozen lanes
      // and SF2 pre-render lanes deliberately bypass their stored DSP, so
      // they need the same neutral declaration before receiving PDC.
      const hasDeclaredTrackStrip =
        track.frozen === undefined && !usesPreRenderedSf2 && stripHasDsp(strip);
      if (hasDeclaredTrackStrip && strip) {
        // Frozen tracks bypass their strip DSP (baked into the render).
        engine.setStrip(trackId, stripScene(trackId, strip));
        strip.inserts.forEach((slot, insertIndex) => {
          engine.setStripInsertBypassed(trackId, insertIndex, { bypassed: !slot.enabled });
        });
        engineEqBands(strip).forEach((band, bandIndex) => {
          engine.setStripEqBand(trackId, bandIndex, band);
        });
      }
      const channelDelay = pdc.delayFor(pdcTracks[index]);
      if (
        pass.freezeIndex !== index &&
        !hasDeclaredTrackStrip &&
        (channelDelay > 0 || enginePannerNeedsStrip(strip))
      ) {
        // libsonare rejects channel-delay and panner setters for lanes without
        // a strip scene. Install this neutral scene before the panner setters
        // below; replacing a scene must not erase a lane's pan mode or dual-pan.
        engine.setStrip(trackId, stripScene(trackId, undefined));
      }
      if (pass.stemIndices === null) {
        // Solo-safe lanes and routed group members stay in the effective solo
        // group while any solo is active.
        engine.setTrackSoloMute(trackId, {
          solo: soloStates[index] ?? false,
          mute: effectiveTrackMute(track.mute, track.vcaId, vcaControlsById),
        });
      } else {
        engine.setTrackSoloMute(trackId, { solo: false, mute: !pass.stemIndices.has(index) });
      }
      if (pass.freezeIndex === index) {
        // Pre-fader freeze: the lane renders at unity/centered with neutral pan
        // shaping; the live fader/pan/pan-law keep applying to the baked audio.
        engine.setParameter(trackLaneParamId(engine, trackId, 'faderDb'), 0);
        engine.setParameter(trackLaneParamId(engine, trackId, 'pan'), 0);
      } else {
        // Lane fader includes the strip trim and the track's VCA group offset,
        // so a VCA-attenuated track exports at the level it plays back at.
        engine.setParameter(
          trackLaneParamId(engine, trackId, 'faderDb'),
          laneGainDb(track.volume, strip?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDbById)),
        );
        // MixerStrip.pan is canonical. Fall back to DocumentTrack.pan so
        // pre-migration projects and freshly imported foreign documents pan
        // identically before and after a save/load cycle.
        const pan = clampPan(strip?.pan ?? track.pan ?? 0);
        engine.setParameter(trackLaneParamId(engine, trackId, 'pan'), pan);
        // Pan law / mode / dual-pan / channel-delay shape the lane exactly as
        // live mixer-sync does; emit only the non-defaults to keep the command
        // budget small (the engine starts each lane at these defaults).
        const panner = engineBusPanState(strip);
        if (panner.panLaw !== ENGINE_DEFAULT_PAN_LAW) engine.setStripPanLaw(trackId, panner.panLaw);
        if (panner.panMode !== ENGINE_DEFAULT_PAN_MODE) {
          engine.setStripPanMode(trackId, panner.panMode);
        }
        if (panner.dualPanLeft !== -1 || panner.dualPanRight !== 1) {
          engine.setStripDualPan(trackId, panner.dualPanLeft, panner.dualPanRight);
        }
        // The pre-rendered SF2 PCM contains the insert processor's own
        // latency, but not the live PDC channel delay (freeze passes keep it
        // outside the bake), so the final lane still receives normal PDC.
        if (channelDelay > 0) engine.setStripChannelDelaySamples(trackId, channelDelay);
      }
    });

    // Insert sidechain keys (document inserts carry positional sources).
    doc.tracks.forEach((track, index) => {
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      if (track.kind === 'group' || usesPreRenderedSf2) return;
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
        engine.setStripSidechain(trackIds[index], insertIndex, {
          kind: 'track',
          id: trackIds[sourceIndex],
        });
      });
    });

    // Bus and master keys are attached after their insert scenes exist. A
    // document stores track/group references positionally and return bus keys
    // by stable bus id; resolve them to this render pass's compact engine IDs.
    const sidechainSource = (slot: unknown): SidechainSource | null => {
      if (!slot || typeof slot !== 'object') return null;
      const source = slot as {
        sidechainSourceIndex?: number;
        sidechainSourceBusId?: string;
        sidechainSourceGroupTrackIndex?: number;
      };
      if (
        Number.isInteger(source.sidechainSourceIndex) &&
        (source.sidechainSourceIndex as number) >= 0 &&
        (source.sidechainSourceIndex as number) < trackIds.length
      ) {
        return { kind: 'track', id: trackIds[source.sidechainSourceIndex as number] };
      }
      if (source.sidechainSourceBusId !== undefined) {
        const id = busNumberById.get(source.sidechainSourceBusId);
        if (id !== undefined) return { kind: 'bus', id };
      }
      if (source.sidechainSourceGroupTrackIndex !== undefined) {
        const id = groupBusByTrackIndex.get(source.sidechainSourceGroupTrackIndex);
        if (id !== undefined) return { kind: 'bus', id };
      }
      return null;
    };
    const keyBusInsert = (
      busId: number,
      strip: MixerStrip | undefined,
      insertIndex: number,
      slot: unknown,
    ): void => {
      const source = sidechainSource(slot);
      if (!source) return;
      const engineIndex = engineBusInsertAutomationIndex(
        strip,
        insertIndex,
        supportsBusInsertBypass,
      );
      if (engineIndex === undefined) return;
      engine.setBusSidechain(busId, engineIndex, source);
    };
    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      bus.strip?.inserts.forEach((slot, insertIndex) => {
        keyBusInsert(busId, bus.strip, insertIndex, slot);
      });
    }
    doc.tracks.forEach((track, index) => {
      if (track.kind !== 'group') return;
      const busId = groupBusByTrackIndex.get(index);
      if (busId === undefined) return;
      track.mixer?.inserts.forEach((slot, insertIndex) => {
        keyBusInsert(busId, track.mixer, insertIndex, slot);
      });
    });

    // Master strip: inserts/EQ only with the chain enabled; gain/pan whenever
    // the pass renders master levels (stems are pre-master).
    const master = doc.mixer?.master;
    // `liveMasterStrip` is strictly a preview optimization. Offline export
    // keeps the master strip independent, then applies the entire mastering
    // rack after its preset in declared order below.
    const masterStrip = master;
    if (
      pass.masterStrip &&
      masterStrip &&
      (stripHasDsp(masterStrip) || enginePannerNeedsStrip(masterStrip))
    ) {
      engine.setStrip('master', stripScene('master', masterStrip));
      masterStrip.inserts.forEach((slot, insertIndex) => {
        engine.setStripInsertBypassed('master', insertIndex, { bypassed: !slot.enabled });
      });
      engineEqBands(masterStrip).forEach((band, bandIndex) => {
        engine.setStripEqBand('master', bandIndex, band);
      });
      masterStrip.inserts.forEach((slot, insertIndex) => {
        const source = sidechainSource(slot);
        if (!source) return;
        engine.setStripSidechain('master', insertIndex, source);
      });
    }
    if (pass.masterLevels) {
      engine.setParameter(masterParamId(engine, 'faderDb'), master?.gainDb ?? 0);
      engine.setParameter(masterParamId(engine, 'pan'), clampPan(master?.pan ?? 0));
    }

    // Automation lanes (track entries + master), enabled lanes only.
    doc.tracks.forEach((track, index) => {
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      for (const lane of track.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        if (pass.freezeIndex === index && (lane.param === 'faderDb' || lane.param === 'pan')) {
          continue;
        }
        const points =
          lane.param === 'faderDb'
            ? engineFaderAutomationPoints(
                lane.points,
                vcaOffsetDb(track.vcaId, vcaGainDbById),
                effectiveTrackMute(track.mute, track.vcaId, vcaControlsById),
              )
            : engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        // Insert-parameter lanes resolve to the engine's reserved insert id
        // (and strip selector) from the strip state already installed above; a
        // negative id means the insert or key is unknown and is skipped.
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          if (usesPreRenderedSf2) continue;
          const storeInsertIndex = insertIndexForAutomationRef(
            track.mixer?.inserts ?? [],
            insertRef,
          );
          if (storeInsertIndex === undefined) continue;
          const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
          if (groupBusId !== undefined) {
            const insertIndex = engineBusInsertAutomationIndex(
              track.mixer,
              storeInsertIndex,
              supportsBusInsertBypass,
            );
            if (insertIndex === undefined) continue;
            const id = resolveAutomationId(() =>
              engine.resolveBusInsertAutomationId(groupBusId, insertIndex, insertRef.paramName),
            );
            if (id !== undefined) engine.setAutomationLane(id, points);
            continue;
          }
          const id = resolveAutomationId(() =>
            engine.resolveStripInsertAutomationId(
              trackIds[index],
              storeInsertIndex,
              insertRef.paramName,
            ),
          );
          if (id !== undefined) engine.setAutomationLane(id, points);
          continue;
        }
        if (parseInstrumentAutomationParam(lane.param)) continue;
        if (lane.param !== 'faderDb' && lane.param !== 'pan') continue;
        const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
        if (groupBusId !== undefined) {
          if (
            lane.param === 'faderDb' &&
            !returnSolo.active &&
            !effectiveTrackMute(track.mute, track.vcaId, vcaControlsById)
          ) {
            engine.setAutomationLane(busFaderParamId(engine, groupBusId), points);
          }
          continue;
        }
        engine.setAutomationLane(trackLaneParamId(engine, trackIds[index], lane.param), points);
      }
    });
    if (pass.masterLevels) {
      for (const lane of doc.masterAutomation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const storeInsertIndex = insertIndexForAutomationRef(
            doc.mixer?.master.inserts ?? [],
            insertRef,
          );
          if (storeInsertIndex === undefined) continue;
          const id = resolveAutomationId(() =>
            engine.resolveStripInsertAutomationId('master', storeInsertIndex, insertRef.paramName),
          );
          if (id !== undefined) engine.setAutomationLane(id, points);
          continue;
        }
        if (parseMasteringAutomationParam(lane.param)) continue;
        if (lane.param !== 'faderDb' && lane.param !== 'pan') continue;
        engine.setAutomationLane(masterParamId(engine, lane.param), points);
      }
    }
    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      for (const lane of bus.automation ?? []) {
        // A muted/non-selected return must override fader automation for the
        // whole render. The stored lane remains intact and resumes when the
        // temporary routing state is released.
        if (
          lane.param === 'faderDb' &&
          (bus.mute === true || (returnSolo.active && !returnSolo.isSoloed(bus.id)))
        )
          continue;
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const storeInsertIndex = insertIndexForAutomationRef(bus.strip?.inserts ?? [], insertRef);
          if (storeInsertIndex === undefined) continue;
          const insertIndex = engineBusInsertAutomationIndex(
            bus?.strip,
            storeInsertIndex,
            supportsBusInsertBypass,
          );
          if (insertIndex === undefined) continue;
          const id = resolveAutomationId(() =>
            engine.resolveBusInsertAutomationId(busId, insertIndex, insertRef.paramName),
          );
          if (id !== undefined) engine.setAutomationLane(id, points);
          continue;
        }
        if (lane.param !== 'faderDb') continue;
        engine.setAutomationLane(busFaderParamId(engine, busId), points);
      }
    }

    engine.setTempoSegments(
      tempoSegments.map((s) => ({
        startPpq: s.startPpq,
        bpm: s.bpm,
        ...(s.endBpm !== undefined ? { endBpm: s.endBpm } : {}),
      })),
    );

    // Instruments for MIDI tracks use the same resolution as live playback.
    // A regular pass can bind all SF2 destinations only when they share one
    // font. Conflicting projects first run isolated, font-fixed pre-fader
    // bounces; their final pass binds no SF2 player and schedules those
    // bounces as audio on the original lanes instead.
    let loadedFontId: string | undefined;
    const boundSf2Destinations: GsSysExDestination[] = [];
    for (let index = 0; index < doc.tracks.length; index++) {
      const track = doc.tracks[index];
      if (track.kind !== 'midi') continue;
      if (track.frozen !== undefined) continue;
      const instrument = effectiveInstruments[index];
      const destinationId = trackIds[index];
      if (instrument?.kind === 'synth-preset') {
        const preset = resolvePreset(instrument.preset);
        engine.setSynthInstrument(
          destinationId,
          instrument.useGmPrograms === true ? { preset, useGmPrograms: true } : { preset },
        );
      } else if (instrument?.kind === 'synth-patch') {
        engine.setSynthInstrument(destinationId, instrument.patch);
      } else if (instrument?.kind === 'sf2') {
        if (pass.sf2TrackIndices !== null && !pass.sf2TrackIndices.has(index)) continue;
        const bytes = fontBytesById.get(instrument.fontId);
        if (bytes && instrument.fontId !== loadedFontId) {
          engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        engine.setSf2Instrument(destinationId, sf2PlaybackConfig(instrument));
        if (bytes !== undefined) {
          boundSf2Destinations.push({
            destinationId,
            bindingKey: JSON.stringify({ instrument, fontId: instrument.fontId }),
          });
        }
      }
      // Instrument lanes resolve against the instrument just bound, as live.
      if (instrument !== undefined && isNativeSynthInstrument(instrument)) {
        for (const lane of track.automation ?? []) {
          const ref = lane.enabled ? parseInstrumentAutomationParam(lane.param) : undefined;
          if (!ref) continue;
          const points = engineAutomationPoints(lane.points);
          const id = resolveAutomationId(() =>
            engine.resolveInstrumentAutomationId(destinationId, ref.paramName),
          );
          if (points.length > 0 && id !== undefined) engine.setAutomationLane(id, points);
        }
      }
      // External-MIDI tracks have no internal instrument and no external device
      // during an offline render, so they bind nothing here and stay silent.
      // Apply the track's live, non-destructive MIDI-FX insert so the export
      // matches live playback (the same engine transform, applied here rather
      // than baked into the notes).
      if (
        track.midiFx !== undefined &&
        (instrument?.kind !== 'sf2' ||
          pass.sf2TrackIndices === null ||
          pass.sf2TrackIndices.has(index))
      ) {
        const config = midiFxConfig(track.midiFx);
        if (config !== null) engine.setMidiFx(destinationId, config);
      }
    }

    const gsSetup = pushGsSetupSysex(
      engine,
      doc.tracks.flatMap((track) => track.clips),
      boundSf2Destinations,
    );
    if (gsSetup.unsupportedPacketCount > 0 && !warnedUnsupportedGsSysex) {
      console.warn(
        `Offline render: ${gsSetup.unsupportedPacketCount} SMF SysEx packet(s) were kept for SMF roundtrip and not applied to realtime GS instruments (only complete setup frames at PPQ 0 up to ${MAX_REALTIME_SYSEX_BYTES} bytes are supported).`,
      );
      warnedUnsupportedGsSysex = true;
    }

    const passMidiSchedules = midiSchedules.filter((schedule) => {
      const trackIndex =
        schedule.destinationId === undefined ? undefined : schedule.destinationId - 1;
      if (trackIndex !== undefined && effectiveInstruments[trackIndex]?.kind === 'external-midi') {
        return false;
      }
      return (
        !pass.usePreRenderedSf2 ||
        trackIndex === undefined ||
        !conflictingSf2TrackIndices.has(trackIndex)
      );
    });
    if (passMidiSchedules.length > 0) engine.setMidiClips(passMidiSchedules);
    // A paged clip carries a provider where a decoded clip carries channels;
    // the engine accepts either form in the same schedule.
    const passClips: Array<EngineClipSpec | PagedClipSpec> =
      pagedClips.length > 0 ? [...renderAudioClips, ...pagedClips] : renderAudioClips;
    // Every warped clip gets a stretch voice, up to the engine's ceiling.
    const warpedClips = renderAudioClips.filter((clip) => clip.warpMode === 'timeStretch').length;
    engine.setWarpVoiceCapacity(
      Math.min(MAX_WARP_VOICES, Math.max(DEFAULT_WARP_VOICES, warpedClips)),
    );
    if (includeClips && passClips.length > 0) engine.setClips(passClips as EngineClipSpec[]);
  };
}

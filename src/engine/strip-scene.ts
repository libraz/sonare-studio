import {
  DEFAULT_SURROUND_PAN,
  type MasteringChainState,
  type MixerChannelLayout,
  type MixerStrip,
} from '@/project/mixer';
import type { EqBand } from '@/wasm/index.js';
import { engineBusPanState, engineEqBands } from './engine-declaration';

export interface BusSceneJsonOptions {
  /** Include bus EQ metadata for engines that expose the bus-EQ ABI. */
  includeEq?: boolean;
  /** Channel layout of the bus; absent keeps the stereo default. */
  channelLayout?: MixerChannelLayout;
}

/**
 * Builds the scene JSON declaring one BUS strip's insert chain (group
 * tracks; exported for tests). Mirrors {@link stripSceneJson} but emits the
 * scene's buses list, which setBusStripJson consumes.
 */
export function busSceneJson(
  busId: number,
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
  options: BusSceneJsonOptions = {},
): string {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } };
  });
  // The bus carries the same output trim/width/polarity stages a strip exposes;
  // each is emitted only when non-default so an unshaped bus stays byte-identical.
  const bus: {
    id: string;
    role: string;
    inserts: typeof inserts;
    layout?: MixerChannelLayout;
    inputTrimDb?: number;
    width?: number;
    polarityInvertLeft?: boolean;
    polarityInvertRight?: boolean;
    pan?: number;
    panMode?: number;
    dualPanLeft?: number;
    dualPanRight?: number;
    panLaw?: number;
    eq?: { enabled: true; bands: EqBand[] };
  } = { id: `bus-${busId}`, role: 'submix', inserts };
  const channelLayout = options.channelLayout;
  const surroundBus = channelLayout === '5.1' || channelLayout === '7.1';
  if (channelLayout !== undefined && channelLayout !== 'stereo') {
    bus.layout = channelLayout;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) bus.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (!surroundBus && width !== 1) bus.width = width;
  if (strip?.polarityInvertLeft === true) bus.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) bus.polarityInvertRight = true;
  const pan = engineBusPanState(strip);
  if (!surroundBus) {
    if (pan.pan !== 0) bus.pan = pan.pan;
    if (pan.panMode !== 0) bus.panMode = pan.panMode;
    if (pan.dualPanLeft !== -1) bus.dualPanLeft = pan.dualPanLeft;
    if (pan.dualPanRight !== 1) bus.dualPanRight = pan.dualPanRight;
    if (pan.panLaw !== 0) bus.panLaw = pan.panLaw;
  }
  const eqBands = options.includeEq ? engineEqBands(strip) : [];
  if (eqBands.length > 0) bus.eq = { enabled: true, bands: eqBands };
  return JSON.stringify({ version: 1, strips: [], buses: [bus], connections: [] });
}

/**
 * Builds the scene JSON declaring one strip's insert chain (exported for
 * tests). Track strips leave faderDb/pan on the mixer lane. Master strip JSON
 * repeats its current fader/pan because replacing the master scene resets
 * those scalars in libsonare. EQ is edited per band after the JSON send. Each insert's
 * "params" value is embedded as an object, the form the engine writes.
 *
 * @param target Track id, or 'master' for the master strip.
 * @param strip Store strip (undefined = neutral, declares an empty strip).
 * @param insertCatalog Known processor names; a non-null catalog rejects
 *   unknown processors instead of silently dropping them.
 * @returns The scene JSON string for setTrackStripJson/setMasterStripJson.
 */
export function stripSceneJson(
  target: number | 'master',
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): string {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } };
  });
  const id = target === 'master' ? 'master' : `track-${target}`;
  const sceneStrip: Record<string, unknown> = { id, inserts };
  if (target === 'master') {
    if ((strip?.gainDb ?? 0) !== 0) sceneStrip.faderDb = strip?.gainDb;
    if ((strip?.pan ?? 0) !== 0) sceneStrip.pan = strip?.pan;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) sceneStrip.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (width !== 1) sceneStrip.width = width;
  if (strip?.polarityInvertLeft === true) sceneStrip.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) sceneStrip.polarityInvertRight = true;
  if (strip?.sourceLayout !== undefined && strip.sourceLayout !== 'stereo') {
    sceneStrip.sourceLayout = strip.sourceLayout;
  }
  const surroundPan = strip?.surroundPan;
  if (
    surroundPan &&
    (surroundPan.azimuth !== DEFAULT_SURROUND_PAN.azimuth ||
      surroundPan.elevation !== DEFAULT_SURROUND_PAN.elevation ||
      surroundPan.divergence !== DEFAULT_SURROUND_PAN.divergence ||
      surroundPan.lfe !== DEFAULT_SURROUND_PAN.lfe ||
      surroundPan.distance !== DEFAULT_SURROUND_PAN.distance)
  ) {
    sceneStrip.surroundPan = { ...surroundPan };
  }
  if (target === 'master') {
    const panner = engineBusPanState(strip);
    if (panner.panLaw !== 0) sceneStrip.panLaw = panner.panLaw;
    if (panner.panMode !== 0) sceneStrip.panMode = panner.panMode;
    if (panner.dualPanLeft !== -1) sceneStrip.dualPanLeft = panner.dualPanLeft;
    if (panner.dualPanRight !== 1) sceneStrip.dualPanRight = panner.dualPanRight;
  }
  return JSON.stringify({ version: 1, strips: [sceneStrip], buses: [], connections: [] });
}

/**
 * Live playback has no separate post-master mastering-chain node. Mirror the
 * realtime-safe processor slots by appending them to the master strip scene;
 * the opaque preset and offline-only processors remain export-only.
 */
export function liveMasterStrip(
  master: MixerStrip,
  chain: MasteringChainState | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): MixerStrip {
  const realtimeProcessors = (chain?.processors ?? []).filter(
    (slot) => slot.enabled && (!insertCatalog || insertCatalog.has(slot.processor)),
  );
  if (realtimeProcessors.length === 0) return master;
  return {
    ...master,
    inserts: [
      ...master.inserts,
      ...realtimeProcessors.map((slot) => ({
        processor: slot.processor,
        params: { ...slot.params },
        enabled: true,
      })),
    ],
  };
}

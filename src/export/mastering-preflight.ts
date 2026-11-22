import { documentAudibleTrackIndices, resolveRenderWindow } from '@/export/engine-render-context';
import { masteringCapabilityFromCatalog, planMasteringStages } from '@/export/mastering-automation';
import {
  assertMasteringBufferWithinLimit,
  MASTERING_STEREO_FRAME_LIMIT,
} from '@/export/mastering-limit';
import type { MixdownRangePpq } from '@/export/mixdown';
import type { ExportOptionsModel } from '@/export/options';
import { ensureWasm } from '@/lib/wasm';
import { masteringChainIsActive } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';

/**
 * Checks the whole-buffer mastering limit before starting the export worker
 * and returns the mastering parameters the render will leave frozen at the
 * render start (empty when the chain is not applied).
 */
export async function preflightMasteringBuffer(
  doc: ProjectDocument,
  exportModel: ExportOptionsModel,
  loopRegion: MixdownRangePpq | null | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  if (!exportModel.includeMasterChain) return [];
  const chain = doc.mixer?.masteringChain;
  if (!chain || !masteringChainIsActive(chain)) return [];

  const range =
    exportModel.range === 'loop' && loopRegion
      ? loopRegion
      : { startPpq: 0, endPpq: null as number | null };
  const renderWindow = resolveRenderWindow(
    doc,
    normalizeTempoMap(doc.tempoSegments),
    range,
    exportModel.sampleRate,
    exportModel.releaseTailSeconds,
    [],
    documentAudibleTrackIndices(doc),
  );
  signal.throwIfAborted();

  const wasm = await ensureWasm();
  signal.throwIfAborted();
  const catalog = wasm.masteringProcessorCatalog();
  const plan = planMasteringStages(
    chain,
    doc.masterAutomation ?? [],
    range.startPpq,
    masteringCapabilityFromCatalog(catalog),
  );
  if (renderWindow.totalFrames > MASTERING_STEREO_FRAME_LIMIT) {
    assertMasteringBufferWithinLimit({
      totalFrames: renderWindow.totalFrames,
      sampleRate: exportModel.sampleRate,
      includeMasterChain: true,
      usesPreset: chain.preset !== undefined,
      wholeBufferProcessorCount: plan.stages.filter((stage) => stage.kind === 'whole-buffer')
        .length,
    });
  }
  return plan.frozenParams;
}

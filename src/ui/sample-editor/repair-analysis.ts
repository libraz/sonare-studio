/**
 * Display helpers for the sample editor's "Analyze & repair" panel: a concise
 * per-channel defect summary and the stage selection sent to the repair call.
 */

import type {
  MasteringAudioProfileDefects,
  MasteringRepairAnalysis,
  MasteringRepairStage,
  MasteringRepairStageName,
} from '@/wasm/index.js';

/** One measured defect in a channel summary; `kind` selects the localized label. */
export interface RepairDefectItem {
  kind: 'clicks' | 'clipping' | 'crackle' | 'hum' | 'noise';
  value: string;
}

/** One summary row per channel. */
export interface RepairChannelSummary {
  channel: string;
  items: RepairDefectItem[];
}

/**
 * Short channel name: `M` for mono, `L`/`R` for stereo, 1-based numbers beyond.
 *
 * @param index - Zero-based channel index.
 * @param count - Number of channels.
 */
export function repairChannelLabel(index: number, count: number): string {
  if (count === 1) return 'M';
  if (count === 2) return index === 0 ? 'L' : 'R';
  return String(index + 1);
}

/**
 * Lists the defects a channel actually shows (non-zero counts, a found hum)
 * plus its noise floor. Empty when the channel was not measured.
 *
 * @param defects - One channel's defect block from the analysis.
 */
export function repairDefectItems(defects: MasteringAudioProfileDefects): RepairDefectItem[] {
  if (!defects.measured) return [];
  const items: RepairDefectItem[] = [];
  if (defects.clickCount > 0) items.push({ kind: 'clicks', value: String(defects.clickCount) });
  if (defects.clipRunCount > 0) {
    items.push({ kind: 'clipping', value: String(defects.clipRunCount) });
  }
  if (defects.crackleSampleCount > 0) {
    items.push({ kind: 'crackle', value: `${defects.cracklePerSecond.toFixed(1)}/s` });
  }
  if (defects.humFundamentalHz > 0) {
    items.push({ kind: 'hum', value: `${Math.round(defects.humFundamentalHz)} Hz` });
  }
  if (Number.isFinite(defects.noiseFloorDbfs)) {
    items.push({ kind: 'noise', value: `${defects.noiseFloorDbfs.toFixed(0)} dBFS` });
  }
  return items;
}

/**
 * Builds the per-channel summary rows of an analysis.
 *
 * @param analysis - Result of `masteringRepairAnalyze`.
 */
export function repairChannelSummaries(analysis: MasteringRepairAnalysis): RepairChannelSummary[] {
  return analysis.channels.map((defects, index) => ({
    channel: repairChannelLabel(index, analysis.channels.length),
    items: repairDefectItems(defects),
  }));
}

/**
 * True when flat clipped runs were found but declip was withheld because it
 * would also touch louder, unclipped audio.
 *
 * @param analysis - Result of `masteringRepairAnalyze`.
 */
export function declipWithheld(analysis: MasteringRepairAnalysis): boolean {
  return !analysis.declipThresholdSafe && analysis.defects.clipFlatRunCount > 0;
}

/**
 * The recommended stages the user kept checked, with their settings intact.
 *
 * @param analysis - Result of `masteringRepairAnalyze`.
 * @param checked - Stage name to checked state; an absent stage counts as unchecked.
 */
export function checkedRepairStages(
  analysis: MasteringRepairAnalysis,
  checked: Partial<Record<MasteringRepairStageName, boolean>>,
): MasteringRepairStage[] {
  return analysis.recommended.filter((stage) => checked[stage.stage] === true);
}

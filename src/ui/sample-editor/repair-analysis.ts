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
 * plus its noise floor.
 *
 * @param defects - One channel's defect block from the analysis.
 */
export function repairDefectItems(defects: MasteringAudioProfileDefects): RepairDefectItem[] {
  const items: RepairDefectItem[] = [];
  if (defects.click.count > 0) items.push({ kind: 'clicks', value: String(defects.click.count) });
  if (defects.clip.runCount > 0) {
    items.push({ kind: 'clipping', value: String(defects.clip.runCount) });
  }
  if (defects.crackle.sampleCount > 0) {
    items.push({ kind: 'crackle', value: `${defects.crackle.perSecond.toFixed(1)}/s` });
  }
  if (defects.hum.fundamentalHz > 0) {
    items.push({ kind: 'hum', value: `${Math.round(defects.hum.fundamentalHz)} Hz` });
  }
  if (Number.isFinite(defects.noise.floorDbfs)) {
    items.push({ kind: 'noise', value: `${defects.noise.floorDbfs.toFixed(0)} dBFS` });
  }
  return items;
}

/**
 * Builds the per-channel summary rows of an analysis.
 *
 * @param analysis - Result of `masteringRepairAnalyze`.
 */
export function repairChannelSummaries(analysis: MasteringRepairAnalysis): RepairChannelSummary[] {
  const channels = analysis.channels ?? [];
  return channels.map((defects, index) => ({
    channel: repairChannelLabel(index, channels.length),
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
  return !analysis.declipThresholdSafe && (analysis.defects?.clip.flatRunCount ?? 0) > 0;
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

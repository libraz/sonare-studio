/**
 * Formats the structured progress-stage codes emitted by the export pipeline
 * (both the dialog and the offline renderer) into localized labels.
 *
 * The renderer and dialog report machine codes such as `engine.stem:3`,
 * `mastering.preset:foo` or `encode:stem:1/4`. Presenting those raw leaks
 * untranslated internal identifiers into the UI, so this maps each known code
 * to a localized template. Unknown codes fall through unchanged, keeping the
 * progress ticker honest rather than blanking on an unexpected stage.
 */

/** Localized label templates keyed by stage kind (`{name}`/`{index}`/`{total}` params). */
export interface ExportStageLabels {
  preflight: string;
  render: string;
  encode: string;
  prepare: string;
  metering: string;
  finalizing: string;
  mastering: string;
  masteringPreset: string;
  renderStem: string;
  renderBusStem: string;
  encodeStem: string;
}

const ENCODE_STEM = /^encode:stem:(\d+)\/(\d+)$/;
const RENDER_STEM = /^engine\.stem:(-?\d+)$/;
const RENDER_BUS_STEM = /^engine\.busStem:(-?\d+)$/;
const RENDER_SF2 = /^engine\.sf2:(-?\d+)$/;
const MASTERING_PRESET = /^mastering\.preset:(.+)$/;
const MASTERING_PROCESSOR = /^mastering\.(.+)$/;

/**
 * Maps a stage code to a localized label.
 *
 * @param stage Machine stage code, or empty string when idle.
 * @param labels Localized templates.
 * @returns The localized label, or the raw code when unrecognized.
 */
export function formatExportStage(stage: string, labels: ExportStageLabels): string {
  if (stage === '') return '';
  switch (stage) {
    case 'preflight':
      return labels.preflight;
    case 'render':
    case 'engine.render':
      return labels.render;
    case 'encode':
      return labels.encode;
    case 'engine.prepare':
      return labels.prepare;
    case 'metering':
      return labels.metering;
    case 'done':
      return labels.finalizing;
  }
  const encodeStem = ENCODE_STEM.exec(stage);
  if (encodeStem) {
    return labels.encodeStem.replace('{index}', encodeStem[1]).replace('{total}', encodeStem[2]);
  }
  const renderStem = RENDER_STEM.exec(stage);
  if (renderStem) return labels.renderStem.replace('{index}', ordinal(renderStem[1]));
  const renderBusStem = RENDER_BUS_STEM.exec(stage);
  if (renderBusStem) return labels.renderBusStem.replace('{index}', ordinal(renderBusStem[1]));
  const renderSf2 = RENDER_SF2.exec(stage);
  if (renderSf2) return labels.renderStem.replace('{index}', ordinal(renderSf2[1]));
  const masteringPreset = MASTERING_PRESET.exec(stage);
  if (masteringPreset) return labels.masteringPreset.replace('{name}', masteringPreset[1]);
  const mastering = MASTERING_PROCESSOR.exec(stage);
  if (mastering) return labels.mastering.replace('{name}', mastering[1]);
  return stage;
}

/** Machine stage indexes are zero-based; labels shown to people are not. */
function ordinal(index: string): string {
  const parsed = Number(index);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed + 1) : index;
}

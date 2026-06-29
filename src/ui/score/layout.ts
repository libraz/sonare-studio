import type { PageLayout } from '@/notation/print';
import type { LayoutOptions } from '@/notation/verovio';

/** Page formats offered in the score layout popover, in millimeters. */
export const SCORE_PAGE_FORMATS = {
  a4: { label: 'A4', widthMm: 210, heightMm: 297 },
  letter: { label: 'Letter', widthMm: 215.9, heightMm: 279.4 },
} as const;

export type ScorePageFormatKey = keyof typeof SCORE_PAGE_FORMATS;

export interface ScoreLayoutSettings {
  pageFormat: ScorePageFormatKey;
  landscape: boolean;
  pageMarginMm: number;
  scalePercent: number;
  spacingStaff: number;
  barsPerSystem: number;
  barsPerPage: number;
}

/** Page dimensions in millimeters honoring the orientation setting. */
export function scorePageDimsMm(
  settings: Pick<ScoreLayoutSettings, 'pageFormat' | 'landscape'>,
): PageLayout {
  const format = SCORE_PAGE_FORMATS[settings.pageFormat];
  return settings.landscape
    ? { pageWidthMm: format.heightMm, pageHeightMm: format.widthMm }
    : { pageWidthMm: format.widthMm, pageHeightMm: format.heightMm };
}

function baseLayoutOptions(settings: ScoreLayoutSettings): LayoutOptions {
  const dims = scorePageDimsMm(settings);
  const margin = Math.round(Math.max(0, settings.pageMarginMm) * 10);
  return {
    pageWidth: Math.round(dims.pageWidthMm * 10),
    pageHeight: Math.round(dims.pageHeightMm * 10),
    pageMarginTop: margin,
    pageMarginBottom: margin,
    pageMarginLeft: margin,
    pageMarginRight: margin,
    scale: Math.min(100, Math.max(20, Math.round(settings.scalePercent))),
    spacingStaff: Math.max(0, Math.round(settings.spacingStaff)),
    svgViewBox: true,
    header: 'none',
    footer: 'none',
  };
}

/** Paginated Verovio layout used for print/PDF export. */
export function scorePrintLayoutOptions(settings: ScoreLayoutSettings): LayoutOptions {
  return {
    ...baseLayoutOptions(settings),
    breaks: 'auto',
  };
}

/**
 * On-screen layout: one continuous system with no line/system breaks, cropped
 * to content. The engraved strip then scrolls horizontally instead of wrapping.
 */
export function scoreScreenLayoutOptions(settings: ScoreLayoutSettings): LayoutOptions {
  return {
    ...baseLayoutOptions(settings),
    pageWidth: 60000,
    breaks: 'none',
    adjustPageHeight: true,
    adjustPageWidth: true,
  };
}

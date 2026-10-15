import { clamp } from '@/lib/math';
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
    scale: clamp(Math.round(settings.scalePercent), 20, 100),
    spacingStaff: Math.max(0, Math.round(settings.spacingStaff)),
    svgViewBox: true,
    header: 'none',
    footer: 'none',
    // Verovio's setOptions merges rather than resets, so any option one layout
    // variant enables sticks around when switching to another. Default the
    // content-cropping flags off here so the paginated print layout always
    // fills the full page; only the screen layout opts back in below.
    adjustPageHeight: false,
    adjustPageWidth: false,
  };
}

/**
 * Paginated Verovio layout used for print/PDF export.
 *
 * When `barsPerPage` is enabled, `encoded` honors the page breaks injected by
 * `applyLayoutBreaks`, while also honoring its per-`barsPerSystem` system
 * breaks. With no page limit, retain the previous `line` behavior: systems
 * use explicit system breaks when present and Verovio fills pages naturally.
 * With no injected system breaks (`barsPerSystem` = 0), Verovio falls back to
 * automatic system breaks.
 */
export function scorePrintLayoutOptions(settings: ScoreLayoutSettings): LayoutOptions {
  return {
    ...baseLayoutOptions(settings),
    breaks: settings.barsPerPage > 0 ? 'encoded' : 'line',
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

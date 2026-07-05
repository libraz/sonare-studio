import { describe, expect, it } from 'vitest';
import {
  type ScoreLayoutSettings,
  scorePageDimsMm,
  scorePrintLayoutOptions,
  scoreScreenLayoutOptions,
} from '@/ui/score/layout';

const SETTINGS: ScoreLayoutSettings = {
  pageFormat: 'a4',
  landscape: false,
  pageMarginMm: 10,
  scalePercent: 100,
  spacingStaff: 8,
  barsPerSystem: 4,
  barsPerPage: 8,
};

describe('scorePageDimsMm', () => {
  it('returns portrait A4 dimensions', () => {
    expect(scorePageDimsMm({ pageFormat: 'a4', landscape: false })).toEqual({
      pageWidthMm: 210,
      pageHeightMm: 297,
    });
  });

  it('swaps width and height for landscape', () => {
    expect(scorePageDimsMm({ pageFormat: 'a4', landscape: true })).toEqual({
      pageWidthMm: 297,
      pageHeightMm: 210,
    });
  });
});

describe('score layout option builders', () => {
  it('paginates the print layout at full page size, honoring injected system breaks', () => {
    const print = scorePrintLayoutOptions(SETTINGS);
    // `line` honors the injected per-barsPerSystem system breaks (readable,
    // bounded systems) while pages break automatically to fill each sheet, so
    // the whole score is emitted. `auto` crams a dense run into one system and
    // `encoded` leaves pages half-empty by forcing the injected page breaks.
    expect(print.breaks).toBe('line');
    expect(print.pageWidth).toBe(2100);
    expect(print.pageHeight).toBe(2970);
    // The page must not be cropped to content, otherwise the printed SVG
    // collapses into a thin band centered on an otherwise blank sheet.
    expect(print.adjustPageHeight).toBe(false);
    expect(print.adjustPageWidth).toBe(false);
  });

  it('crops the screen layout to content as one continuous system', () => {
    const screen = scoreScreenLayoutOptions(SETTINGS);
    expect(screen.breaks).toBe('none');
    expect(screen.adjustPageHeight).toBe(true);
    expect(screen.adjustPageWidth).toBe(true);
  });

  it('keeps the content-cropping flags explicit in both variants so Verovio option merge cannot leak state', () => {
    // Verovio's setOptions merges; every flag one variant sets must be set by
    // the other so switching layouts fully overrides the previous one.
    const print = scorePrintLayoutOptions(SETTINGS);
    const screen = scoreScreenLayoutOptions(SETTINGS);
    expect(print.adjustPageHeight).not.toBe(screen.adjustPageHeight);
    expect(print.adjustPageWidth).not.toBe(screen.adjustPageWidth);
  });
});

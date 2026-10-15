/**
 * XML escaping and the fixed scaffolding of a MusicXML document: the encoding
 * header, the engraving defaults and the credit block. None of it depends on
 * the music being written.
 */

import { escapeXmlMarkup } from '@/export/xml-escape';
import type { ScoreMetadata } from './model';

/**
 * Escapes the five XML-reserved characters in text or attribute content and
 * replaces code points XML 1.0 forbids.
 */
export const escapeXml = escapeXmlMarkup;

/** Software credit written into the MusicXML `<encoding>` block. */
export const ENCODING_SOFTWARE = 'sonare studio';

/** MusicXML tenths per millimeter under the default 40 tenths / 7 mm scaling. */
export const TENTHS_PER_MM = 40 / 7;

/** A4 portrait page geometry in millimeters. */
export const A4_PAGE_MM = { width: 210, height: 297 } as const;

/** Conservative printable margins in MusicXML tenths. */
export const PAGE_MARGIN_TENTHS = {
  left: 70,
  right: 70,
  top: 70,
  bottom: 70,
} as const;

/**
 * Appends the optional `<work>` / `<identification>` header.
 *
 * `<work-title>` is emitted only when a non-empty title is present; the
 * `<identification>` block carries the composer credit (when set) and always
 * records the encoding software so exported files are self-describing.
 *
 * @param lines Output line buffer.
 * @param metadata Optional score metadata.
 */
export function appendScoreHeader(lines: string[], metadata: ScoreMetadata | undefined): void {
  const title = metadata?.title?.trim();
  const composer = metadata?.composer?.trim();
  if (title) {
    lines.push(`<work><work-title>${escapeXml(title)}</work-title></work>`);
  }
  lines.push('<identification>');
  if (composer) {
    lines.push(`<creator type="composer">${escapeXml(composer)}</creator>`);
  }
  lines.push(`<encoding><software>${escapeXml(ENCODING_SOFTWARE)}</software></encoding>`);
  lines.push('</identification>');
}

/** Appends stable print-layout defaults for MusicXML importers. */
export function appendScoreDefaults(lines: string[]): void {
  const pageWidth = Math.round(A4_PAGE_MM.width * TENTHS_PER_MM);
  const pageHeight = Math.round(A4_PAGE_MM.height * TENTHS_PER_MM);
  lines.push('<defaults>');
  lines.push('<scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>');
  lines.push(
    '<page-layout>' +
      `<page-height>${pageHeight}</page-height>` +
      `<page-width>${pageWidth}</page-width>` +
      '<page-margins type="both">' +
      `<left-margin>${PAGE_MARGIN_TENTHS.left}</left-margin>` +
      `<right-margin>${PAGE_MARGIN_TENTHS.right}</right-margin>` +
      `<top-margin>${PAGE_MARGIN_TENTHS.top}</top-margin>` +
      `<bottom-margin>${PAGE_MARGIN_TENTHS.bottom}</bottom-margin>` +
      '</page-margins>' +
      '</page-layout>',
  );
  lines.push(
    '<system-layout>' +
      '<system-margins><left-margin>0</left-margin><right-margin>0</right-margin></system-margins>' +
      '<system-distance>150</system-distance>' +
      '<top-system-distance>100</top-system-distance>' +
      '</system-layout>',
  );
  lines.push('<staff-layout><staff-distance>80</staff-distance></staff-layout>');
  lines.push(
    '<appearance>' +
      '<line-width type="beam">5</line-width>' +
      '<line-width type="bracket">4</line-width>' +
      '<line-width type="dashes">1</line-width>' +
      '<line-width type="enclosure">1</line-width>' +
      '<line-width type="ending">1.2</line-width>' +
      '<line-width type="extend">1</line-width>' +
      '<line-width type="heavy barline">5</line-width>' +
      '<line-width type="leger">1.6</line-width>' +
      '<line-width type="light barline">1.6</line-width>' +
      '<line-width type="octave shift">1.2</line-width>' +
      '<line-width type="pedal">1.2</line-width>' +
      '<line-width type="slur middle">1.6</line-width>' +
      '<line-width type="slur tip">0.5</line-width>' +
      '<line-width type="staff">1.1</line-width>' +
      '<line-width type="stem">1</line-width>' +
      '<line-width type="tie middle">1.6</line-width>' +
      '<line-width type="tie tip">0.5</line-width>' +
      '<note-size type="cue">60</note-size>' +
      '<note-size type="grace">60</note-size>' +
      '</appearance>',
  );
  lines.push('</defaults>');
}

/** Appends printable title/composer/part credits when metadata is present. */
export function appendScoreCredits(lines: string[], metadata: ScoreMetadata | undefined): void {
  const title = metadata?.title?.trim();
  const composer = metadata?.composer?.trim();
  const partName = metadata?.partName?.trim();
  if (title) {
    lines.push(
      `<credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" default-y="1600" font-size="18">${escapeXml(title)}</credit-words></credit>`,
    );
  }
  if (composer) {
    lines.push(
      `<credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="top" default-y="1560" font-size="11">${escapeXml(composer)}</credit-words></credit>`,
    );
  }
  if (partName) {
    lines.push(
      `<credit page="1"><credit-type>part name</credit-type><credit-words justify="left" valign="top" default-y="1560" font-size="12">${escapeXml(partName)}</credit-words></credit>`,
    );
  }
}

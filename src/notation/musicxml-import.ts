/**
 * Pragmatic MusicXML importer for the browser DAW.
 *
 * Parses a `score-partwise` MusicXML document into a {@link ProjectDocument}
 * with the same shape the Standard MIDI File importer produces (one MIDI track
 * per part, a single clip per track, plus the project tempo / time-signature /
 * key-signature maps). It is a note-level importer aimed at correctness on the
 * common cases rather than full MusicXML coverage: it understands pitches,
 * chords, rests, ties, voices/staves, `<backup>`/`<forward>`, `<divisions>`,
 * key/time attributes, and tempo from `<sound tempo>` or `<metronome>`.
 *
 * Timing is mapped from MusicXML divisions to the app PPQ convention (quarter
 * note = 1.0). The parser is defensive: malformed XML raises
 * {@link MusicXmlImportError}, and a well-formed document with no importable
 * parts yields an empty-but-valid project rather than throwing.
 */

import { type LossReport, LossTally } from '@/export/loss-descriptor';
import {
  type DocumentTempoSegment,
  type DocumentTimeSignature,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { presetForGmProgram } from '@/project/smf';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import { TRACK_COLOR_PALETTE } from '@/project/types';
import {
  ImportLossWalker,
  MUSICXML_IMPORT_LOSS_KINDS,
  type MusicXmlImportLossKind,
} from './musicxml-import-loss';
import {
  clipFromNotes,
  type GlobalMaps,
  type InstrumentMapping,
  importPartNotes,
  type PartInfo,
  readPartList,
} from './musicxml-import-parts';
import {
  childElements,
  childText,
  DEFAULT_MUSICXML_IMPORT_LIMITS,
  type MusicXmlImportLimits,
  parseScoreRoot,
  type XmlElement,
} from './musicxml-import-xml';

export { MUSICXML_IMPORT_LOSS_KINDS, type MusicXmlImportLossKind } from './musicxml-import-loss';
export {
  DEFAULT_MUSICXML_IMPORT_LIMITS,
  MusicXmlImportError,
  type MusicXmlImportLimits,
} from './musicxml-import-xml';

/** Sample rate assigned to imported projects (matches the SMF importer). */
const DEFAULT_SAMPLE_RATE = 48000;

function resolveImportLimits(limits: Partial<MusicXmlImportLimits> = {}): MusicXmlImportLimits {
  return { ...DEFAULT_MUSICXML_IMPORT_LIMITS, ...limits };
}

export interface MusicXmlImportResult {
  document: ProjectDocument;
  report: LossReport<MusicXmlImportLossKind>;
}

/** Extra `<midi-instrument>` programs a part declares beyond the one its track plays. */
function extraInstrumentCount(part: PartInfo): number {
  const [primary, ...rest] = [...part.instruments.values()];
  return rest.filter((entry) => entry.program !== undefined && entry.program !== primary?.program)
    .length;
}

/** Collapses raw global tempo events into an ordered, deduplicated map. */
function tempoSegments(tempos: Map<number, number>): DocumentTempoSegment[] {
  const sorted = [...tempos.entries()]
    .map(([ppq, bpm]) => ({ startPpq: Math.max(0, ppq), bpm }))
    .sort((a, b) => a.startPpq - b.startPpq);
  const segments: DocumentTempoSegment[] = [];
  for (const segment of sorted) {
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.bpm === segment.bpm) continue;
    segments.push(segment);
  }
  if (segments.length === 0 || segments[0].startPpq > 0) {
    segments.unshift({ startPpq: 0, bpm: segments[0]?.bpm ?? DEFAULT_TEMPO_BPM });
  }
  return segments;
}

/** Collapses raw global time-signature events into an ordered list. */
function timeSignatureSegments(entries: GlobalMaps['timeSignatures']): DocumentTimeSignature[] {
  const sorted = entries
    .map((entry) => ({
      startPpq: Math.max(0, entry.ppq),
      numerator: entry.numerator,
      denominator: entry.denominator,
    }))
    .sort((a, b) => a.startPpq - b.startPpq);
  const segments: DocumentTimeSignature[] = [];
  for (const segment of sorted) {
    const previous = segments[segments.length - 1];
    if (
      previous !== undefined &&
      previous.numerator === segment.numerator &&
      previous.denominator === segment.denominator
    ) {
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** Derives the project name from the score header or the source file name. */
function projectName(root: XmlElement, fileName?: string): string {
  const work = childElements(root, 'work')[0];
  const title = work !== undefined ? childText(work, 'work-title') : null;
  if (title !== null) return title;
  const movement = childText(root, 'movement-title');
  if (movement !== null) return movement;
  if (fileName !== undefined) {
    const base = fileName.replace(/\.[^./\\]+$/, '');
    const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
    const trimmed = (slash >= 0 ? base.slice(slash + 1) : base).trim();
    if (trimmed !== '') return trimmed;
  }
  return 'Imported MusicXML';
}

/**
 * Imports a MusicXML `score-partwise` document into a {@link ProjectDocument}.
 *
 * @param xml MusicXML source text.
 * @param fileName Optional source file name used for the project title.
 * @returns A project document with one MIDI track per part.
 * @throws MusicXmlImportError When the input is not well-formed or supported.
 */
export function importMusicXmlWithReport(
  xml: string,
  fileName?: string,
  limits: Partial<MusicXmlImportLimits> = {},
): MusicXmlImportResult {
  const resolved = resolveImportLimits(limits);
  const root = parseScoreRoot(xml, resolved);
  const partInfos = readPartList(root, resolved.maxNumericAbs);
  const global: GlobalMaps = { tempos: new Map(), timeSignatures: [], keys: [] };
  const tracks: ProjectDocument['tracks'] = [];
  const partElements = childElements(root, 'part');
  const tempoConflicts = new Set<string>();
  const loss = new LossTally(MUSICXML_IMPORT_LOSS_KINDS);
  const lossWalker = new ImportLossWalker(loss);
  let canonicalTempos: DocumentTempoSegment[] | null = null;
  partElements.forEach((partEl, index) => {
    const id = partEl.attributes.id ?? `P${index + 1}`;
    const info = partInfos.get(id) ?? { name: id, instruments: new Map() };
    const imported = importPartNotes(
      partEl,
      info,
      global,
      index === 0,
      canonicalTempos,
      tempoConflicts,
      id,
      resolved.maxNumericAbs,
      lossWalker,
    );
    if (index === 0) canonicalTempos = tempoSegments(global.tempos);
    const name = info.name || `Part ${index + 1}`;
    loss.add('extra-instruments', extraInstrumentCount(info), name);
    const primaryInstrument = info.instruments.values().next().value as
      | InstrumentMapping
      | undefined;
    const instrument =
      primaryInstrument?.program === undefined
        ? undefined
        : {
            kind: 'synth-preset' as const,
            preset: presetForGmProgram(primaryInstrument.program, primaryInstrument.channel ?? 0),
            useGmPrograms: true as const,
            gmProgram: primaryInstrument.program,
          };
    tracks.push({
      name,
      musicXmlPartId: id,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: primaryInstrument?.volume ?? 1,
      pan: primaryInstrument?.pan ?? 0,
      ...(instrument !== undefined ? { instrument } : {}),
      clips: [clipFromNotes(name, imported.notes, imported.endPpq)],
    });
  });

  const markers = global.keys.slice().sort((a, b) => a.ppq - b.ppq || a.name.localeCompare(b.name));

  const document: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectName(root, fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: tempoSegments(global.tempos),
    timeSignatures: timeSignatureSegments(global.timeSignatures),
    tracks,
    markers,
    sections: [],
    ...(global.pickupLengthPpq !== undefined ? { pickupLengthPpq: global.pickupLengthPpq } : {}),
  };
  loss.add('tempo-conflicts', tempoConflicts.size);
  return { document, report: loss.report() };
}

/** Compatibility API for callers that do not need the structured loss report. */
export function importMusicXml(xml: string, fileName?: string): ProjectDocument {
  return importMusicXmlWithReport(xml, fileName).document;
}

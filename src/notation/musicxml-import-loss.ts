/**
 * What a MusicXML import does not realize: the loss classes the import dialog
 * lists and the walker that counts them element by element.
 */

import type { LossTally } from '@/export/loss-descriptor';
import type { XmlElement } from './musicxml-import-xml';

/** Every class the MusicXML import loss dialog can list, in dialog order. */
export const MUSICXML_IMPORT_LOSS_KINDS = [
  'harmony',
  'lyrics',
  'repeats',
  'jumps',
  'dynamics',
  'fingering',
  'fermatas',
  'arpeggios',
  'annotations',
  'grace-notes',
  'figured-bass',
  'extra-instruments',
  'tempo-conflicts',
  'other-notation',
] as const;

export type MusicXmlImportLossKind = (typeof MUSICXML_IMPORT_LOSS_KINDS)[number];

/**
 * How the importer treats each element it can meet inside a measure:
 * `realized` feeds the document, `presentation` is engraving-only, a loss kind
 * is counted. An element missing from its table is counted as other notation,
 * so the report never omits a class the importer ignores.
 */
type ElementDisposition = 'realized' | 'presentation' | 'walk' | MusicXmlImportLossKind;

const MEASURE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  attributes: 'realized',
  note: 'walk',
  backup: 'realized',
  forward: 'realized',
  direction: 'walk',
  sound: 'walk',
  harmony: 'harmony',
  'figured-bass': 'figured-bass',
  barline: 'walk',
  print: 'presentation',
  grouping: 'presentation',
  link: 'presentation',
  bookmark: 'presentation',
  listening: 'presentation',
};

const BARLINE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  'bar-style': 'presentation',
  repeat: 'repeats',
  ending: 'repeats',
  segno: 'jumps',
  coda: 'jumps',
  fermata: 'fermatas',
  'wavy-line': 'annotations',
  footnote: 'presentation',
  level: 'presentation',
};

const DIRECTION_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  'direction-type': 'walk',
  offset: 'realized',
  sound: 'walk',
  staff: 'presentation',
  voice: 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  listening: 'presentation',
};

const DIRECTION_TYPE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  metronome: 'realized',
  // Realized only through a sound dynamics attribute; checked by the walker.
  dynamics: 'dynamics',
  segno: 'jumps',
  coda: 'jumps',
  words: 'presentation',
  rehearsal: 'presentation',
  symbol: 'presentation',
  dashes: 'presentation',
  bracket: 'presentation',
  image: 'presentation',
  'staff-divide': 'presentation',
  wedge: 'annotations',
  pedal: 'annotations',
  'octave-shift': 'annotations',
  'harp-pedals': 'annotations',
  damp: 'annotations',
  'damp-all': 'annotations',
  eyeglasses: 'annotations',
  'string-mute': 'annotations',
  scordatura: 'annotations',
  'principal-voice': 'annotations',
  percussion: 'annotations',
  'accordion-registration': 'annotations',
  'other-direction': 'annotations',
};

const NOTE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  grace: 'grace-notes',
  cue: 'realized',
  chord: 'realized',
  pitch: 'realized',
  unpitched: 'realized',
  rest: 'realized',
  duration: 'realized',
  tie: 'realized',
  instrument: 'realized',
  voice: 'realized',
  staff: 'realized',
  type: 'presentation',
  dot: 'presentation',
  accidental: 'presentation',
  'time-modification': 'presentation',
  stem: 'presentation',
  notehead: 'presentation',
  'notehead-text': 'presentation',
  beam: 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  play: 'presentation',
  listen: 'presentation',
  notations: 'walk',
  lyric: 'lyrics',
};

const NOTATIONS_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  tied: 'presentation',
  tuplet: 'presentation',
  'accidental-mark': 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  technical: 'walk',
  dynamics: 'dynamics',
  fermata: 'fermatas',
  arpeggiate: 'arpeggios',
  'non-arpeggiate': 'arpeggios',
  slur: 'annotations',
  glissando: 'annotations',
  slide: 'annotations',
  ornaments: 'annotations',
  articulations: 'annotations',
  'other-notation': 'annotations',
};

/** `<sound>` attributes that restructure playback order, which import never applies. */
const SOUND_JUMP_ATTRIBUTES = ['dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine'] as const;

/** Records what the importer does not realize while it walks a part. */
export class ImportLossWalker {
  private readonly otherTags = new Set<string>();

  constructor(readonly loss: LossTally<MusicXmlImportLossKind>) {}

  private count(element: XmlElement, table: Readonly<Record<string, ElementDisposition>>): void {
    const disposition = table[element.tagName];
    if (disposition === 'realized' || disposition === 'presentation' || disposition === 'walk') {
      return;
    }
    if (disposition !== undefined) {
      this.loss.add(disposition);
      return;
    }
    const detail = this.otherTags.has(element.tagName) ? undefined : element.tagName;
    this.otherTags.add(element.tagName);
    this.loss.add('other-notation', 1, detail);
  }

  measureChild(element: XmlElement): void {
    this.count(element, MEASURE_ELEMENTS);
    if (element.tagName === 'barline') {
      for (const child of element.children) this.count(child, BARLINE_ELEMENTS);
    } else if (element.tagName === 'sound') {
      this.sound(element);
    }
  }

  direction(direction: XmlElement, dynamicsRealized: boolean): void {
    for (const child of direction.children) {
      this.count(child, DIRECTION_ELEMENTS);
      if (child.tagName === 'sound') this.sound(child);
      if (child.tagName !== 'direction-type') continue;
      for (const type of child.children) {
        if (type.tagName === 'dynamics' && dynamicsRealized) continue;
        this.count(type, DIRECTION_TYPE_ELEMENTS);
      }
    }
  }

  note(note: XmlElement): void {
    for (const child of note.children) {
      this.count(child, NOTE_ELEMENTS);
      if (child.tagName !== 'notations') continue;
      for (const notation of child.children) {
        this.count(notation, NOTATIONS_ELEMENTS);
        if (notation.tagName !== 'technical') continue;
        for (const technical of notation.children) {
          this.loss.add(technical.tagName === 'fingering' ? 'fingering' : 'annotations');
        }
      }
    }
  }

  private sound(sound: XmlElement): void {
    if (SOUND_JUMP_ATTRIBUTES.some((name) => sound.attributes[name] !== undefined)) {
      this.loss.add('jumps');
    }
  }
}

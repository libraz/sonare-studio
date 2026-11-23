/**
 * A note's `<notations>`: ties, tuplet brackets, slurs, glissandi,
 * articulations, ornaments, fingering and the inferred percussion roll.
 */

import type { NoteArticulation, NoteOrnament } from '@/project/annotations';
import { beatGroupPpq, beatOriginPpq, type NotatedEvent, type NotatedMeasure } from './model';
import { type AnnotationIndex, slurPlacement } from './musicxml-annotation-index';
import { percussionTechnicalXml } from './musicxml-percussion';
import { PPQ_EPSILON } from './musicxml-shared';
import { escapeXml } from './musicxml-xml';

/**
 * MusicXML articulation element name per annotation marking.
 *
 * A marking absent from this table has no element of its own in the format and
 * is written as `<other-articulation>` carrying its name, which is what the
 * schema provides for a technique it does not enumerate; a reader that knows
 * the name gets the intent, and one that does not still parses the file.
 */
const ARTICULATION_ELEMENT: Readonly<Partial<Record<NoteArticulation, string>>> = {
  staccato: 'staccato',
  accent: 'accent',
  tenuto: 'tenuto',
  marcato: 'strong-accent',
};

/**
 * Builds the `<notations>` element of one `<note>`, or an empty string when
 * there is nothing to notate. Tied marks appear on every chord note; slurs
 * and articulations only on the first chord note (`isFirstPitch`).
 */
export function notationsXml(
  event: NotatedEvent,
  annotations: AnnotationIndex,
  isFirstPitch: boolean,
  percussion = false,
  midi?: number,
  measure?: NotatedMeasure,
  pitchIndex = 0,
): string {
  let inner = '';
  if (event.tieStop) {
    inner += '<tied type="stop"/>';
  }
  if (event.tieStart) {
    inner += '<tied type="start"/>';
  }
  if (isFirstPitch) {
    inner += tupletBracketXml(event, measure);
    for (const number of annotations.slurStops.get(event) ?? []) {
      inner += `<slur type="stop" number="${number}"/>`;
    }
    for (const number of annotations.slurStarts.get(event) ?? []) {
      const placement = annotations.slurStartPlacements.get(event)?.get(number);
      const placementXml = placement === undefined ? '' : ` placement="${placement}"`;
      inner += `<slur type="start" number="${number}"${placementXml}/>`;
    }
    for (const lineSpan of annotations.lineSpanStops.get(event) ?? []) {
      if (lineSpan.type === 'glissando') {
        const lineType =
          lineSpan.glissandoLineType === undefined
            ? ''
            : ` line-type="${lineSpan.glissandoLineType}"`;
        inner += `<glissando type="stop" number="${lineSpan.number}"${lineType}/>`;
      }
    }
    for (const lineSpan of annotations.lineSpanStarts.get(event) ?? []) {
      if (lineSpan.type === 'glissando') {
        const lineType =
          lineSpan.glissandoLineType === undefined
            ? ''
            : ` line-type="${lineSpan.glissandoLineType}"`;
        inner +=
          lineSpan.glissandoText === undefined
            ? `<glissando type="start" number="${lineSpan.number}"${lineType}/>`
            : `<glissando type="start" number="${lineSpan.number}"${lineType}>${escapeXml(lineSpan.glissandoText)}</glissando>`;
      }
    }
    const articulation = annotations.articulations.get(event);
    if (articulation !== undefined) {
      inner += `<articulations>${articulationXml(articulation, event)}</articulations>`;
    } else if (percussion && event.velocity !== undefined && event.velocity >= 112) {
      inner += `<articulations><accent placement="${slurPlacement(event)}"/></articulations>`;
    }
    const ornament = annotations.ornaments.get(event);
    if (ornament !== undefined) {
      inner += ornamentXml(ornament);
    }
  }
  if (!percussion && !event.tieStop) {
    // Fingering is per-note and per key press: each chord pitch carries its own
    // finger number, written on the attack and not on a tied continuation.
    const fingering = event.fingering?.[pitchIndex];
    if (fingering !== undefined) {
      inner += `<technical><fingering>${fingering}</fingering></technical>`;
    }
  }
  if (percussion && midi !== undefined) {
    const technical = percussionTechnicalXml(midi);
    if (technical !== '') inner += technical;
    if (measure !== undefined && isPercussionRoll(event, measure, midi, annotations)) {
      inner += '<ornaments><tremolo type="single">3</tremolo></ornaments>';
    }
  }
  return inner === '' ? '' : `<notations>${inner}</notations>`;
}

/** Emits tuplet bracket start/stop marks for the first and last event in a group. */
export function tupletBracketXml(event: NotatedEvent, measure: NotatedMeasure | undefined): string {
  if (!event.value.tuplet || measure === undefined) return '';
  const voice = measure.voices.find((entry) => entry.voice === event.voice);
  if (!voice) return '';
  const index = voice.events.indexOf(event);
  if (index < 0) return '';
  const prev = voice.events[index - 1];
  const next = voice.events[index + 1];
  const sameGroup = (candidate: NotatedEvent | undefined): boolean =>
    candidate !== undefined &&
    (event.tupletGroupId !== undefined
      ? candidate.tupletGroupId === event.tupletGroupId
      : candidate.tupletGroupId === undefined && sameTuplet(candidate, event));
  const hasPrev =
    sameGroup(prev) && Math.abs(prev.startPpq + prev.durationPpq - event.startPpq) < PPQ_EPSILON;
  const hasNext =
    sameGroup(next) && Math.abs(event.startPpq + event.durationPpq - next.startPpq) < PPQ_EPSILON;
  let xml = '';
  if (!hasPrev) xml += '<tuplet type="start"/>';
  if (!hasNext) xml += '<tuplet type="stop"/>';
  return xml;
}

/** True when two events belong to the same simple tuplet ratio. */
function sameTuplet(a: NotatedEvent, b: NotatedEvent): boolean {
  const left = a.value.tuplet;
  const right = b.value.tuplet;
  return (
    left !== undefined &&
    right !== undefined &&
    left.actual === right.actual &&
    left.normal === right.normal &&
    a.value.base === b.value.base
  );
}

/**
 * Returns true when repeated short drum notes should carry a roll/tremolo mark.
 *
 * The reading is of the figure, not of one note: four sixteenths on the snare
 * inside a beat read as a roll only together. So a technique written on any of
 * them stands the guess down for all of them — the figure has been described,
 * and a run of ghost notes marked as a roll would contradict what it says.
 */
function isPercussionRoll(
  event: NotatedEvent,
  measure: NotatedMeasure,
  midi: number,
  annotations: AnnotationIndex,
): boolean {
  if (!isRollCandidate(midi) || event.durationPpq > 0.25 + PPQ_EPSILON) return false;
  const groupLen = beatGroupPpq(measure.timeSig);
  const origin = beatOriginPpq(measure);
  const groupIndex = Math.floor((event.startPpq - origin) / groupLen + PPQ_EPSILON);
  let count = 0;
  for (const voice of measure.voices) {
    for (const candidate of voice.events) {
      if (
        candidate.kind !== 'note' ||
        candidate.voice !== event.voice ||
        candidate.durationPpq > 0.25 + PPQ_EPSILON ||
        !candidate.pitches.includes(midi)
      ) {
        continue;
      }
      const candidateGroup = Math.floor((candidate.startPpq - origin) / groupLen + PPQ_EPSILON);
      if (candidateGroup !== groupIndex) continue;
      if (annotations.articulations.has(candidate)) return false;
      count++;
    }
  }
  return count >= 3;
}

/** Drum notes for which rapid repeated hits are conventionally roll-like. */
function isRollCandidate(midi: number): boolean {
  return [37, 38, 40, 41, 43, 45, 47, 48, 50].includes(midi);
}

/** Builds a voice-aware articulation element. */
function articulationXml(articulation: NoteArticulation, event: NotatedEvent): string {
  const placement = slurPlacement(event);
  const element = ARTICULATION_ELEMENT[articulation];
  return element === undefined
    ? `<other-articulation placement="${placement}">${escapeXml(articulation)}</other-articulation>`
    : `<${element} placement="${placement}"/>`;
}

/** Builds a MusicXML ornament or expression notation. */
function ornamentXml(ornament: NoteOrnament): string {
  switch (ornament) {
    case 'trill':
      return '<ornaments><trill-mark/></ornaments>';
    case 'turn':
      return '<ornaments><turn/></ornaments>';
    case 'mordent':
      return '<ornaments><mordent/></ornaments>';
    case 'fermata':
      return '<fermata type="upright"/>';
  }
}

/**
 * Measure-level `<direction>` elements: rehearsal marks, tempo and text
 * directions, and the pedal and octave-shift lines spanning notes.
 */

import type { NoteLineSpan } from '@/project/annotations';
import {
  beatGroupPpq,
  type NotatedMeasureText,
  type NotatedTempoMark,
  type NotatedTempoText,
  type NotatedTimeSig,
  ppqToDivisions,
  ppqToNoteValue,
} from './model';
import type { LineSpanRender } from './musicxml-annotation-index';
import { PPQ_EPSILON, tempoText } from './musicxml-shared';
import { escapeXml } from './musicxml-xml';

/** Builds a rehearsal mark direction for section labels. */
export function rehearsalDirectionXml(label: string | undefined): string {
  const text = label?.trim();
  if (!text) return '';
  return `<direction placement="above"><direction-type><rehearsal default-y="40">${escapeXml(text)}</rehearsal></direction-type></direction>`;
}

/** Builds a metronome tempo direction plus playback tempo. */
export function tempoDirectionXml(
  mark: NotatedTempoMark,
  timeSig: NotatedTimeSig,
  divisions: number,
): string {
  const { bpm } = mark;
  if (!Number.isFinite(bpm) || bpm <= 0) return '';
  const beatGroup = beatGroupPpq(timeSig);
  const perMinute = tempoText(bpm / beatGroup);
  const playbackTempo = tempoText(bpm);
  const offset = directionOffsetXml(mark.offsetPpq, divisions);
  return `<direction placement="above"><direction-type><metronome>${metronomeBeatUnitXml(beatGroup)}<per-minute>${perMinute}</per-minute></metronome></direction-type>${offset}<sound tempo="${playbackTempo}"/></direction>`;
}

/** Builds the metronome beat unit for a PPQ beat group. */
function metronomeBeatUnitXml(ppq: number): string {
  const value = ppqToNoteValue(ppq);
  return `<beat-unit>${value.base}</beat-unit>${'<beat-unit-dot/>'.repeat(value.dots)}`;
}

/** Builds a textual tempo directive such as rit., accel. or a tempo. */
export function tempoTextDirectionXml(mark: NotatedTempoText, divisions: number): string {
  const text = mark.text.trim();
  if (!text) return '';
  const sound =
    mark.bpm !== undefined && Number.isFinite(mark.bpm) && mark.bpm > 0
      ? `<sound tempo="${tempoText(mark.bpm)}"/>`
      : '';
  const offset = directionOffsetXml(mark.offsetPpq ?? 0, divisions);
  return `<direction placement="above"><direction-type><words default-y="30" font-style="italic">${escapeXml(text)}</words></direction-type>${offset}${sound}</direction>`;
}

/** MusicXML direction offset, omitted at the containing measure start. */
function directionOffsetXml(offsetPpq: number, divisions: number): string {
  if (!Number.isFinite(offsetPpq) || offsetPpq <= PPQ_EPSILON) return '';
  return `<offset>${ppqToDivisions(offsetPpq, divisions)}</offset>`;
}

/** Builds a general text direction. */
export function measureTextDirectionXml(mark: NotatedMeasureText): string {
  const text = mark.text.trim();
  if (!text) return '';
  const defaultY =
    mark.defaultY !== undefined && Number.isFinite(mark.defaultY)
      ? ` default-y="${mark.defaultY}"`
      : '';
  return `<direction placement="above"><direction-type><words${defaultY}>${escapeXml(text)}</words></direction-type></direction>`;
}

type OctaveLineSpan = Exclude<NoteLineSpan, 'pedal' | 'glissando'>;

/**
 * MusicXML octave-shift semantics for the four editor ottava markings.
 *
 * MusicXML's direction is relative to the true pitch in the note data, not
 * the visual direction of the printed 8va/8vb label: an 8va label moves the
 * written notes up, so its MusicXML shift is `down`; 8vb is the inverse.
 */
const OCTAVE_SHIFT_BY_LINE_SPAN: Readonly<
  Record<OctaveLineSpan, { placement: 'above' | 'below'; shift: 'up' | 'down'; size: 8 | 15 }>
> = {
  'ottava-up': { placement: 'above', shift: 'down', size: 8 },
  'ottava-down': { placement: 'below', shift: 'up', size: 8 },
  'ottava-15-up': { placement: 'above', shift: 'down', size: 15 },
  'ottava-15-down': { placement: 'below', shift: 'up', size: 15 },
};

function octaveShiftDirection(lineSpan: OctaveLineSpan): {
  placement: 'above' | 'below';
  shift: 'up' | 'down';
  size: 8 | 15;
} {
  return OCTAVE_SHIFT_BY_LINE_SPAN[lineSpan];
}

/** Builds non-glissando span directions. */
export function lineSpanDirectionXml(
  lineSpan: LineSpanRender & { type: Exclude<NoteLineSpan, 'glissando'> },
  position: 'start' | 'stop',
  staffXml: string,
): string {
  if (lineSpan.type === 'pedal') {
    const line = lineSpan.pedalStyle === 'sign' ? 'no' : 'yes';
    const sign =
      lineSpan.pedalStyle === 'sign' ? ` sign="${position === 'start' ? 'yes' : 'no'}"` : '';
    return `<direction placement="below"><direction-type><pedal type="${position}" line="${line}"${sign} number="${lineSpan.number}"/></direction-type>${staffXml}</direction>`;
  }
  const { placement, shift, size } = octaveShiftDirection(lineSpan.type);
  const type = position === 'stop' ? 'stop' : shift;
  return `<direction placement="${placement}"><direction-type><octave-shift type="${type}" size="${size}" number="${lineSpan.number}"/></direction-type>${staffXml}</direction>`;
}

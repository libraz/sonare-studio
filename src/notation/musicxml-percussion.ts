/**
 * Percussion notation: unpitched staff placement, noteheads and instrument
 * definitions.
 *
 * A drum part names instruments rather than pitches, so it needs its own staff
 * mapping and its own <score-instrument> set; nothing here applies to a pitched
 * part.
 */

import type { NotatedEvent, NotatedPart } from './model';
import type { ScoreInstrumentDefinition } from './musicxml-shared';
import { escapeXml } from './musicxml-xml';
import type { Step } from './pitch-spelling';
/** General MIDI percussion channel (MIDI channel 10, stored as 0-based 9). */
export const GM_PERCUSSION_CHANNEL = 9;

export interface PercussionDisplay {
  step: Step;
  octave: number;
  notehead?: string;
  name: string;
}

/** Conservatively infers drum/percussion parts from their display name. */
export function isPercussionPartName(part: NotatedPart): boolean {
  return /\b(drum|drums|kit|percussion|perc|cajon|conga|bongo)\b/i.test(part.name);
}

/**
 * Uses MIDI channel metadata as the primary percussion signal. Part-name
 * inference remains only as a compatibility fallback for hand-authored scores
 * that do not carry source channel metadata.
 */
export function partUsesPercussionMap(part: NotatedPart): boolean {
  let sawChannelMetadata = false;
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note' || event.midiChannels === undefined) continue;
        if (event.midiChannels.length > 0) sawChannelMetadata = true;
        if (event.midiChannels.includes(GM_PERCUSSION_CHANNEL)) return true;
      }
    }
  }
  return sawChannelMetadata ? false : isPercussionPartName(part);
}

/** Returns true when a note event should be serialized with a drum map. */
export function eventUsesPercussionMap(
  event: NotatedEvent,
  partPercussionFallback: boolean,
): boolean {
  if (event.midiChannels !== undefined && event.midiChannels.length > 0) {
    return event.midiChannels.includes(GM_PERCUSSION_CHANNEL);
  }
  return partPercussionFallback;
}

/** Returns percussion pitches used by this part, sorted by GM note number. */
export function percussionPitches(part: NotatedPart): number[] {
  const pitches = new Set<number>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note' || !eventUsesPercussionMap(event, true)) continue;
        for (const pitch of event.pitches) pitches.add(pitch);
      }
    }
  }
  return [...pitches].sort((a, b) => a - b);
}

/** Builds part-list instrument metadata for drum maps. */
export function percussionInstrumentDefinitions(part: NotatedPart): ScoreInstrumentDefinition[] {
  return percussionPitches(part).map((pitch) => ({
    id: percussionInstrumentId(part.id, pitch),
    name: percussionDisplay(pitch).name,
    channel: GM_PERCUSSION_CHANNEL + 1,
    unpitched: pitch + 1,
  }));
}

/** Stable MusicXML score-instrument id for one GM percussion pitch. */
export function percussionInstrumentId(partId: string, midi: number): string {
  return `${escapeXml(partId)}-I${midi}`;
}

/** Maps common GM drum notes to readable percussion positions and names. */
export function percussionDisplay(midi: number): PercussionDisplay {
  switch (midi) {
    case 35:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Acoustic Bass Drum' };
    case 36:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Bass Drum 1' };
    case 37:
      return { step: 'B', octave: 4, notehead: 'normal', name: 'Side Stick' };
    case 38:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Acoustic Snare' };
    case 39:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Hand Clap' };
    case 40:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Electric Snare' };
    case 41:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Low Floor Tom' };
    case 42:
      return { step: 'G', octave: 5, notehead: 'x', name: 'Closed Hi-Hat' };
    case 43:
      return { step: 'G', octave: 4, notehead: 'normal', name: 'High Floor Tom' };
    case 44:
      return { step: 'F', octave: 5, notehead: 'x', name: 'Pedal Hi-Hat' };
    case 45:
      return { step: 'A', octave: 4, notehead: 'normal', name: 'Low Tom' };
    case 46:
      return { step: 'A', octave: 5, notehead: 'x', name: 'Open Hi-Hat' };
    case 47:
      return { step: 'B', octave: 4, notehead: 'normal', name: 'Low-Mid Tom' };
    case 48:
      return { step: 'D', octave: 5, notehead: 'normal', name: 'Hi-Mid Tom' };
    case 49:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Crash Cymbal 1' };
    case 50:
      return { step: 'E', octave: 5, notehead: 'normal', name: 'High Tom' };
    case 51:
      return { step: 'D', octave: 6, notehead: 'x', name: 'Ride Cymbal 1' };
    case 52:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Chinese Cymbal' };
    case 53:
      return { step: 'D', octave: 6, notehead: 'normal', name: 'Ride Bell' };
    case 54:
      return { step: 'B', octave: 5, notehead: 'x', name: 'Tambourine' };
    case 55:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Splash Cymbal' };
    case 56:
      return { step: 'B', octave: 4, notehead: 'x', name: 'Cowbell' };
    case 57:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Crash Cymbal 2' };
    case 58:
      return { step: 'A', octave: 5, notehead: 'x', name: 'Vibraslap' };
    case 59:
      return { step: 'D', octave: 6, notehead: 'x', name: 'Ride Cymbal 2' };
    default:
      return {
        step: 'C',
        octave: 5,
        notehead: midi >= 42 && midi <= 59 ? 'x' : 'normal',
        name: `GM Percussion ${midi}`,
      };
  }
}

/** Builds a MusicXML unpitched notehead location. */
export function unpitchedXml(display: PercussionDisplay): string {
  return `<unpitched><display-step>${display.step}</display-step><display-octave>${display.octave}</display-octave></unpitched>`;
}

/** Builds an optional MusicXML notehead. */
export function noteheadXml(display: PercussionDisplay, event: NotatedEvent): string {
  if (display.notehead === undefined) return '';
  const parentheses =
    event.velocity !== undefined && event.velocity <= 45 ? ' parentheses="yes"' : '';
  return `<notehead${parentheses}>${display.notehead}</notehead>`;
}

/** Builds percussion technique markings for common GM drum articulations. */
export function percussionTechnicalXml(midi: number): string {
  switch (midi) {
    case 42:
      return '<technical><stopped/></technical>';
    case 46:
      return '<technical><open-string/></technical>';
    default:
      return '';
  }
}

/** Builds a compact first-system drum-map legend for printed percussion parts. */
export function percussionLegendDirectionXml(part: NotatedPart): string {
  const items = percussionPitches(part)
    .slice(0, 8)
    .map((pitch) => `${percussionDisplay(pitch).name}=${pitch}`)
    .join(', ');
  if (items === '') return '';
  return `<direction placement="above"><direction-type><words default-y="18" font-size="8">${escapeXml(`Drum map: ${items}`)}</words></direction-type></direction>`;
}

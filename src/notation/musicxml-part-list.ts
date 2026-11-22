/**
 * The `<part-list>` entries: part names, abbreviations and the pitched and
 * percussion instrument definitions a part's notes refer to by id.
 */

import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import type { NotatedPart } from './model';
import { partUsesPercussionMap, percussionInstrumentDefinitions } from './musicxml-percussion';
import type { ScoreInstrumentDefinition } from './musicxml-shared';
import { escapeXml } from './musicxml-xml';

/** Builds a score-part entry with a deterministic abbreviation. */
export function scorePartXml(part: NotatedPart): string {
  const name = escapeXml(part.name);
  const abbreviation = escapeXml(partAbbreviation(part.name));
  const instruments = scorePartInstrumentsXml(part);
  return `<score-part id="${escapeXml(part.id)}"><part-name>${name}</part-name><part-abbreviation>${abbreviation}</part-abbreviation>${instruments}</score-part>`;
}

/** Pitched MIDI channels explicitly carried by this part's note events. */
function pitchedChannels(part: NotatedPart): number[] {
  const channels = new Set<number>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note') continue;
        for (const channel of event.midiChannels ?? []) {
          if (channel !== GM_PERCUSSION_CHANNEL && channel >= 0 && channel <= 15) {
            channels.add(channel);
          }
        }
      }
    }
  }
  return [...channels].sort((a, b) => a - b);
}

export function pitchedInstrumentId(partId: string, channel: number): string {
  return `${escapeXml(partId)}-C${channel + 1}`;
}

function pitchedInstrumentDefinitions(part: NotatedPart): ScoreInstrumentDefinition[] {
  return pitchedChannels(part).map((channel) => ({
    id: pitchedInstrumentId(part.id, channel),
    name: `${part.name || 'Part'} channel ${channel + 1}`,
    channel: channel + 1,
  }));
}

/**
 * MusicXML requires all `<score-instrument>` entries to precede every
 * `<midi-instrument>` entry inside a score-part. Keep that content-model order
 * even when a part carries several pitched channels or a drum map.
 */
function scorePartInstrumentsXml(part: NotatedPart): string {
  const definitions = [
    ...pitchedInstrumentDefinitions(part),
    ...(partUsesPercussionMap(part) ? percussionInstrumentDefinitions(part) : []),
  ];
  const scoreInstruments = definitions
    .map(
      ({ id, name }) =>
        `<score-instrument id="${id}"><instrument-name>${escapeXml(name)}</instrument-name></score-instrument>`,
    )
    .join('');
  const midiInstruments = definitions
    .map(({ id, channel, unpitched }) => {
      const midiUnpitched =
        unpitched === undefined ? '' : `<midi-unpitched>${unpitched}</midi-unpitched>`;
      return `<midi-instrument id="${id}"><midi-channel>${channel}</midi-channel>${midiUnpitched}</midi-instrument>`;
    })
    .join('');
  return scoreInstruments + midiInstruments;
}

/** Derives a compact part abbreviation when the model has no explicit one. */
function partAbbreviation(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 11)}.`;
  const initials = words
    .filter((word) => /[A-Za-z0-9]/.test(word))
    .map((word) => word[0].toUpperCase())
    .join('');
  return initials.length > 0 && initials.length <= 6 ? initials : `${trimmed.slice(0, 11)}.`;
}

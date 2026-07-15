import type { MidiSourceIdentity } from '@/project/midi-projection';

const SCORE_NOTE_ID_PREFIX = 'sonare-note-';

/** Encodes source identities into a MusicXML-safe stable note id. */
export function scoreNoteXmlId(
  identities: ReadonlyArray<MidiSourceIdentity>,
  startPpq: number,
  pitchIndex: number,
): string | undefined {
  if (identities.length === 0) return undefined;
  const sources = identities
    .map((identity) => `c${identity.clipId}n${identity.noteId}o${identity.occurrence}`)
    .join('_');
  const startTicks = Math.round(startPpq * 1_000_000);
  return `${SCORE_NOTE_ID_PREFIX}${sources}-s${startTicks}-p${pitchIndex}`;
}

/** Decodes every composite source identity carried by an engraved note id. */
export function scoreSourceIdentitiesFromXmlId(xmlId: string): MidiSourceIdentity[] {
  if (!xmlId.startsWith(SCORE_NOTE_ID_PREFIX)) return [];
  const sourceSection = xmlId.slice(SCORE_NOTE_ID_PREFIX.length).split('-s', 1)[0];
  const identities: MidiSourceIdentity[] = [];
  for (const token of sourceSection.split('_')) {
    const match = /^c(\d+)n(\d+)o(\d+)$/.exec(token);
    if (!match) return [];
    identities.push({
      clipId: Number(match[1]),
      noteId: Number(match[2]),
      occurrence: Number(match[3]),
    });
  }
  return identities;
}

import {
  type GlissandoLineType,
  type NoteArticulation,
  type NoteDynamics,
  type NoteHairpin,
  type NoteLineSpan,
  type NoteOrnament,
  type PedalLineSpanStyle,
  scoreAnnotationLineSpans,
} from '@/project/annotations';
import type { NotatedEvent, NotatedLyric, NotatedScore } from './model';
import { PPQ_EPSILON, type StaffNumber } from './musicxml-shared';

/** Highest `<slur>` number-level allowed by MusicXML. */
const MAX_SLUR_NUMBER = 16;

/**
 * Display annotations resolved onto engraved events. Built once per
 * serialization from {@link NotatedScore.noteAnnotations}: each annotated
 * editor note id is mapped to its "attack" event (the first piece of a tie
 * chain carrying the id in `sourceIds`); ids without an attack event
 * (deleted notes, notes outside the notated window) are silently ignored.
 */
export interface AnnotationIndex {
  /** Engraving-only staff overrides without mutating the source event model. */
  staffOverrides: Map<NotatedEvent, StaffNumber>;
  /** Dynamics marking to emit as a `<direction>` right before the event. */
  dynamics: Map<NotatedEvent, NoteDynamics>;
  /** Articulation to emit inside the event's `<notations>`. */
  articulations: Map<NotatedEvent, NoteArticulation>;
  /** Ornament to emit inside the event's `<notations>`. */
  ornaments: Map<NotatedEvent, NoteOrnament>;
  /** Slur numbers starting on the event. */
  slurStarts: Map<NotatedEvent, number[]>;
  /** Slur placement attributes keyed by start event and slur number. */
  slurStartPlacements: Map<NotatedEvent, Map<number, string>>;
  /** Slur numbers stopping on the event. */
  slurStops: Map<NotatedEvent, number[]>;
  /** Hairpin wedges starting on the event. */
  hairpinStarts: Map<NotatedEvent, Array<{ number: number; type: NoteHairpin }>>;
  /** Hairpin wedge numbers stopping on the event. */
  hairpinStops: Map<NotatedEvent, number[]>;
  /** Other line/span markings starting on the event. */
  lineSpanStarts: Map<NotatedEvent, LineSpanRender[]>;
  /** Other line/span markings stopping on the event. */
  lineSpanStops: Map<NotatedEvent, LineSpanRender[]>;
}

export interface LineSpanRender {
  number: number;
  type: NoteLineSpan;
  pedalStyle?: PedalLineSpanStyle;
  glissandoLineType?: GlissandoLineType;
  glissandoText?: string;
}

/** Lyric syllables resolved onto note attack events. */
export type LyricIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<NotatedLyric>>;

/** Appends a value to a keyed list inside a map. */
function pushMapped<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Resolves score annotations onto events (see {@link AnnotationIndex}).
 *
 * Slurs are validated here: the target must resolve to a different event
 * that starts strictly after the source, otherwise the slur is dropped.
 * Overlapping slurs receive distinct MusicXML number-levels so start/stop
 * pairs match unambiguously.
 */
export function buildAnnotationIndex(score: NotatedScore): AnnotationIndex {
  const index: AnnotationIndex = {
    staffOverrides: new Map(),
    dynamics: new Map(),
    articulations: new Map(),
    ornaments: new Map(),
    slurStarts: new Map(),
    slurStartPlacements: new Map(),
    slurStops: new Map(),
    hairpinStarts: new Map(),
    hairpinStops: new Map(),
    lineSpanStarts: new Map(),
    lineSpanStops: new Map(),
  };
  const annotations = score.noteAnnotations;
  if (annotations === undefined) return index;
  const attackByNoteId = new Map<number, NotatedEvent>();
  const eventsByNoteId = new Map<number, NotatedEvent[]>();
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind !== 'note' || event.sourceIds === undefined) continue;
          for (const id of event.sourceIds) {
            const events = eventsByNoteId.get(id) ?? [];
            events.push(event);
            eventsByNoteId.set(id, events);
            if (!event.tieStop && !attackByNoteId.has(id)) attackByNoteId.set(id, event);
          }
        }
      }
    }
  }
  const slurs: Array<{ start: NotatedEvent; stop: NotatedEvent }> = [];
  const hairpins: Array<{ start: NotatedEvent; stop: NotatedEvent; type: NoteHairpin }> = [];
  const lineSpans: Array<
    { start: NotatedEvent; stop: NotatedEvent } & Omit<LineSpanRender, 'number'>
  > = [];
  for (const [idKey, annotation] of Object.entries(annotations)) {
    const event = attackByNoteId.get(Number(idKey));
    if (event === undefined) continue; // Orphaned annotation: ignore.
    if (annotation.staffOverride === 1 || annotation.staffOverride === 2) {
      for (const sourceEvent of eventsByNoteId.get(Number(idKey)) ?? []) {
        index.staffOverrides.set(sourceEvent, annotation.staffOverride);
      }
    }
    if (annotation.dynamics !== undefined) index.dynamics.set(event, annotation.dynamics);
    if (annotation.articulation !== undefined) {
      index.articulations.set(event, annotation.articulation);
    }
    if (annotation.ornament !== undefined) index.ornaments.set(event, annotation.ornament);
    if (annotation.slurToNoteId !== undefined) {
      const target = attackByNoteId.get(annotation.slurToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        slurs.push({ start: event, stop: target });
      }
    }
    if (annotation.hairpin !== undefined && annotation.hairpinToNoteId !== undefined) {
      const target = attackByNoteId.get(annotation.hairpinToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        hairpins.push({ start: event, stop: target, type: annotation.hairpin });
      }
    }
    for (const span of scoreAnnotationLineSpans(annotation)) {
      const target = attackByNoteId.get(span.lineSpanToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        lineSpans.push({
          start: event,
          stop: target,
          type: span.lineSpan,
          ...(span.pedalStyle !== undefined ? { pedalStyle: span.pedalStyle } : {}),
          ...(span.glissandoLineType !== undefined
            ? { glissandoLineType: span.glissandoLineType }
            : {}),
          ...(span.glissandoText !== undefined ? { glissandoText: span.glissandoText } : {}),
        });
      }
    }
  }
  slurs.sort((a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq);
  const active: Array<{ endPpq: number; number: number }> = [];
  for (const slur of slurs) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= slur.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: slur.stop.startPpq, number });
    pushMapped(index.slurStarts, slur.start, number);
    const placements = index.slurStartPlacements.get(slur.start) ?? new Map<number, string>();
    placements.set(number, slurPlacement(slur.start));
    index.slurStartPlacements.set(slur.start, placements);
    pushMapped(index.slurStops, slur.stop, number);
  }
  hairpins.sort((a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq);
  active.length = 0;
  for (const hairpin of hairpins) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= hairpin.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: hairpin.stop.startPpq, number });
    const starts = index.hairpinStarts.get(hairpin.start) ?? [];
    starts.push({ number, type: hairpin.type });
    index.hairpinStarts.set(hairpin.start, starts);
    pushMapped(index.hairpinStops, hairpin.stop, number);
  }
  lineSpans.sort(
    (a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq,
  );
  active.length = 0;
  for (const lineSpan of lineSpans) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= lineSpan.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: lineSpan.stop.startPpq, number });
    const render: LineSpanRender = {
      number,
      type: lineSpan.type,
      ...(lineSpan.pedalStyle !== undefined ? { pedalStyle: lineSpan.pedalStyle } : {}),
      ...(lineSpan.glissandoLineType !== undefined
        ? { glissandoLineType: lineSpan.glissandoLineType }
        : {}),
      ...(lineSpan.glissandoText !== undefined ? { glissandoText: lineSpan.glissandoText } : {}),
    };
    const starts = index.lineSpanStarts.get(lineSpan.start) ?? [];
    starts.push(render);
    index.lineSpanStarts.set(lineSpan.start, starts);
    const stops = index.lineSpanStops.get(lineSpan.stop) ?? [];
    stops.push(render);
    index.lineSpanStops.set(lineSpan.stop, stops);
  }
  return index;
}

/** Resolves score-level lyric entries onto the nearest matching note attack. */
export function buildLyricIndex(score: NotatedScore): LyricIndex {
  const lyrics = score.lyrics;
  if (lyrics === undefined || lyrics.length === 0) return new Map();
  const events: Array<{ partId: string; event: NotatedEvent }> = [];
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind === 'note' && !event.tieStop) events.push({ partId: part.id, event });
        }
      }
    }
  }
  const index = new Map<NotatedEvent, NotatedLyric[]>();
  for (const lyric of [...lyrics].sort(compareLyrics)) {
    const text = lyric.text.trim();
    if (text === '') continue;
    const candidates = events.filter(
      ({ partId }) => lyric.partId === undefined || lyric.partId === partId,
    );
    const match = candidates.reduce<(typeof candidates)[number] | undefined>(
      (nearest, candidate) => {
        if (nearest === undefined) return candidate;
        return Math.abs(candidate.event.startPpq - lyric.ppq) <
          Math.abs(nearest.event.startPpq - lyric.ppq)
          ? candidate
          : nearest;
      },
      undefined,
    );
    if (match === undefined) continue;
    const list = index.get(match.event) ?? [];
    list.push({ ...lyric, text });
    index.set(match.event, list);
  }
  return index;
}

function compareLyrics(a: NotatedLyric, b: NotatedLyric): number {
  return a.ppq - b.ppq || (a.verse ?? 1) - (b.verse ?? 1) || a.text.localeCompare(b.text);
}

/** Default slur placement by voice direction. */
export function slurPlacement(event: NotatedEvent): string {
  return event.voice === 1 || event.voice === 3 ? 'above' : 'below';
}

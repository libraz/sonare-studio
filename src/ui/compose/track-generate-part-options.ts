/**
 * Static option tables for the track generator dialog: the part list with its
 * label and role keys, and the choice lists for the motif contour, drum groove,
 * section, drum difficulty, bass style and backing voicing selects. Label keys
 * are resolved against the dialog's i18n group by the caller.
 */
import type { SectionId } from '@/compose/section-shaping';
import { MAX_DRUM_DIFFICULTY, MIN_DRUM_DIFFICULTY, type TrackPart } from '@/project/commands';

export const PART_IDS: readonly TrackPart[] = ['motif', 'drums', 'bass', 'counter', 'backing'];

/** Parts that occupy the mid register (may collide with one another). */
export const MID_RANGE_PARTS: ReadonlySet<TrackPart> = new Set(['motif', 'counter', 'backing']);

export const PART_LABEL_KEYS: Record<
  TrackPart,
  'partMotif' | 'partDrums' | 'partBass' | 'partCounter' | 'partBacking'
> = {
  motif: 'partMotif',
  drums: 'partDrums',
  bass: 'partBass',
  counter: 'partCounter',
  backing: 'partBacking',
};

export const PART_ROLE_KEYS: Record<
  TrackPart,
  'roleMid' | 'roleRhythm' | 'roleLow' | 'roleMidHigh'
> = {
  motif: 'roleMid',
  drums: 'roleRhythm',
  bass: 'roleLow',
  counter: 'roleMidHigh',
  backing: 'roleMid',
};

export type MotifContour = 'arch' | 'ascending' | 'descending' | 'wave';
export const CONTOURS: ReadonlyArray<{
  id: MotifContour;
  labelKey: 'contourArch' | 'contourAscending' | 'contourDescending' | 'contourWave';
}> = [
  { id: 'arch', labelKey: 'contourArch' },
  { id: 'ascending', labelKey: 'contourAscending' },
  { id: 'descending', labelKey: 'contourDescending' },
  { id: 'wave', labelKey: 'contourWave' },
];

export type GrooveId =
  | 'standard'
  | 'funk'
  | 'shuffle'
  | 'bossa'
  | 'trap'
  | 'halftime'
  | 'breakbeat'
  | 'house'
  | 'synthpop';
export const GROOVES: ReadonlyArray<{
  id: GrooveId;
  labelKey:
    | 'grooveStandard'
    | 'grooveFunk'
    | 'grooveShuffle'
    | 'grooveBossa'
    | 'grooveTrap'
    | 'grooveHalftime'
    | 'grooveBreakbeat'
    | 'grooveHouse'
    | 'grooveSynthpop';
}> = [
  { id: 'standard', labelKey: 'grooveStandard' },
  { id: 'funk', labelKey: 'grooveFunk' },
  { id: 'shuffle', labelKey: 'grooveShuffle' },
  { id: 'bossa', labelKey: 'grooveBossa' },
  { id: 'trap', labelKey: 'grooveTrap' },
  { id: 'halftime', labelKey: 'grooveHalftime' },
  { id: 'breakbeat', labelKey: 'grooveBreakbeat' },
  { id: 'house', labelKey: 'grooveHouse' },
  { id: 'synthpop', labelKey: 'grooveSynthpop' },
];

export const SECTIONS: ReadonlyArray<{
  id: SectionId;
  labelKey:
    | 'sectionIntro'
    | 'sectionVerse'
    | 'sectionPrechorus'
    | 'sectionChorus'
    | 'sectionBridge'
    | 'sectionOutro';
}> = [
  { id: 'intro', labelKey: 'sectionIntro' },
  { id: 'verse', labelKey: 'sectionVerse' },
  { id: 'prechorus', labelKey: 'sectionPrechorus' },
  { id: 'chorus', labelKey: 'sectionChorus' },
  { id: 'bridge', labelKey: 'sectionBridge' },
  { id: 'outro', labelKey: 'sectionOutro' },
];

export const DRUM_DIFFICULTIES: ReadonlyArray<number> = Array.from(
  { length: MAX_DRUM_DIFFICULTY - MIN_DRUM_DIFFICULTY + 1 },
  (_unused, index) => MIN_DRUM_DIFFICULTY + index,
);

export type BassStyle = 'root' | 'rootFifth' | 'pop' | 'walking' | 'arpeggio';
export const BASS_STYLES: ReadonlyArray<{
  id: BassStyle;
  labelKey: 'bassRoot' | 'bassRootFifth' | 'bassPop' | 'bassWalking' | 'bassArpeggio';
}> = [
  { id: 'root', labelKey: 'bassRoot' },
  { id: 'rootFifth', labelKey: 'bassRootFifth' },
  { id: 'pop', labelKey: 'bassPop' },
  { id: 'walking', labelKey: 'bassWalking' },
  { id: 'arpeggio', labelKey: 'bassArpeggio' },
];

export type BackingStyleId = 'smooth' | 'close' | 'drop2' | 'drop3' | 'shell' | 'rootless';
export const BACKING_STYLES: ReadonlyArray<{
  id: BackingStyleId;
  labelKey:
    | 'backingSmooth'
    | 'backingClose'
    | 'backingDrop2'
    | 'backingDrop3'
    | 'backingShell'
    | 'backingRootless';
}> = [
  { id: 'smooth', labelKey: 'backingSmooth' },
  { id: 'close', labelKey: 'backingClose' },
  { id: 'drop2', labelKey: 'backingDrop2' },
  { id: 'drop3', labelKey: 'backingDrop3' },
  { id: 'shell', labelKey: 'backingShell' },
  { id: 'rootless', labelKey: 'backingRootless' },
];

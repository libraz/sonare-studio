<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { toSafetyProfile } from '@/compose/guidance-profile';
import { editableDrumTracks, harmonicNotes, isDrumTrack } from '@/compose/tracks';
import { describeError } from '@/lib/errors';
import { clamp01 } from '@/lib/math';
import {
  type BatchPartSpec,
  type BatchTarget,
  createLeadMelodyCommand,
  generateTracksBatchCommand,
  MAX_DRUM_DIFFICULTY,
  MIN_DRUM_DIFFICULTY,
  type TrackPart,
} from '@/project/commands';
import { normalizeGenerationSeed, partForTrack, partSeed } from '@/project/generation';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { MAX_TRACK_LANES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap, ppqDurationSeconds, secondsToPpq } from '@/project/tempo-map';
import {
  advanceBarsPpq,
  barNumberAt,
  barStartPpq,
  barsBetweenPpq,
  isFourFourBarRange,
} from '@/project/time-signature';
import { clipKind } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Flow B: the track generator. A checklist of the five instrumental parts
 * (motif, drums, bass, counter melody, backing), each with a write target and
 * an expandable parameter panel, generated together in one undoable batch. The
 * whole flow is gated behind a chord progression: with no chords the body is a
 * hard gate that routes back to Flow A.
 */

/** Context for opening pre-focused on one part (track-header "regenerate"). */
export interface TrackGenerateOpenWith {
  part: TrackPart;
  target: BatchTarget;
}

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** Optional pre-selection when opened from a track-header "regenerate". */
  openWith?: TrackGenerateOpenWith | null;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
  /** Request to open Flow A (gate's "create" button, or "edit chords" link). */
  openChords: [];
  /** The lead target was created or selected from the completion state. */
  composeLead: [];
}>();

const store = useProjectStore();
const appSettings = useAppSettings();
const { t } = useI18n();

const g = computed(() => t.value.shell.generate.track);

const PART_IDS: readonly TrackPart[] = ['motif', 'drums', 'bass', 'counter', 'backing'];

/** Parts that occupy the mid register (may collide with one another). */
const MID_RANGE_PARTS: ReadonlySet<TrackPart> = new Set(['motif', 'counter', 'backing']);

const PART_LABEL_KEYS: Record<
  TrackPart,
  'partMotif' | 'partDrums' | 'partBass' | 'partCounter' | 'partBacking'
> = {
  motif: 'partMotif',
  drums: 'partDrums',
  bass: 'partBass',
  counter: 'partCounter',
  backing: 'partBacking',
};

const PART_ROLE_KEYS: Record<TrackPart, 'roleMid' | 'roleRhythm' | 'roleLow' | 'roleMidHigh'> = {
  motif: 'roleMid',
  drums: 'roleRhythm',
  bass: 'roleLow',
  counter: 'roleMidHigh',
  backing: 'roleMid',
};

/** Per-part checklist state (params live in the dedicated refs below). */
interface PartState {
  checked: boolean;
  expanded: boolean;
  /** Encoded target: 'new', `replace:<id>`, 'clip:append', 'clip:replace'. */
  target: string;
  /**
   * How many times this part has been rerolled under the project seed. Bumping
   * it gives the part unrelated material and leaves the other parts alone.
   */
  reroll: number;
}

function newPartState(): PartState {
  return { checked: false, expanded: false, target: 'new', reroll: 0 };
}

const parts = reactive<Record<TrackPart, PartState>>({
  motif: newPartState(),
  drums: newPartState(),
  bass: newPartState(),
  counter: newPartState(),
  backing: newPartState(),
});

/** The project seed, bound to the store so it is saved with the project. */
const projectSeed = computed({
  get: () => store.generationSeed,
  set: (value: number) => {
    store.generationSeed = normalizeGenerationSeed(value);
  },
});

/** Draws the seed for a part from the project seed and the part's reroll count. */
function seedFor(part: TrackPart): number {
  return partSeed(store.generationSeed, part, parts[part].reroll);
}

/** Rerolls one part, leaving every other part on the seed it already had. */
function reroll(part: TrackPart): void {
  parts[part].reroll += 1;
}

const error = ref<string | null>(null);
const generating = ref(false);
const done = ref(false);
const wholeBars = ref(4);
const wholeBarsDirty = ref(false);
const durationError = ref<string | null>(null);
const tempoMap = computed(() => normalizeTempoMap(store.tempoSegments, store.tempoBpm));

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

const wholeDuration = computed(() =>
  Number.isFinite(wholeBars.value) && wholeBars.value > 0
    ? ppqDurationSeconds(
        tempoMap.value,
        0,
        advanceBarsPpq(store.timeSignatures, 0, wholeBars.value),
      )
    : 0,
);

const wholeLengthError = computed(() => {
  if (!Number.isInteger(wholeBars.value) || wholeBars.value < 1 || wholeBars.value > 256) {
    return g.value.lengthInvalid;
  }
  if (!isFourFourBarRange(store.timeSignatures, 0, wholeBars.value)) {
    return g.value.lengthMeterError;
  }
  return durationError.value;
});

/** Range replacement and track-header regeneration keep their existing scope. */
const usesWholeLength = computed(
  () => !props.openWith && !(parts.drums.checked && isDrumRangeTarget.value),
);
const appliesWholeLength = computed(
  () =>
    usesWholeLength.value &&
    (['motif', 'drums', 'bass', 'backing'] as const).some(
      (part) => parts[part].checked && isPartAvailable(part),
    ),
);

function setWholeBars(value: number): void {
  wholeBars.value = value;
  wholeBarsDirty.value = true;
  motifBars.value = value;
  drumBars.value = value;
  motifBarsDirty.value = false;
  drumBarsDirty.value = false;
  durationError.value = null;
}

function onWholeBarsInput(event: Event): void {
  setWholeBars(Number((event.target as HTMLInputElement).value));
}

function onDurationChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const match = /^(\d+):([0-5]\d)$/.exec(input.value.trim());
  if (match === null) {
    durationError.value = g.value.lengthTimeInvalid;
    return;
  }
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds <= 0) {
    durationError.value = g.value.lengthTimeInvalid;
    return;
  }
  const lower = Math.max(
    1,
    Math.floor(barsBetweenPpq(store.timeSignatures, 0, secondsToPpq(tempoMap.value, seconds))),
  );
  const upper = lower + 1;
  const lowerSeconds = ppqDurationSeconds(
    tempoMap.value,
    0,
    advanceBarsPpq(store.timeSignatures, 0, lower),
  );
  const upperSeconds = ppqDurationSeconds(
    tempoMap.value,
    0,
    advanceBarsPpq(store.timeSignatures, 0, upper),
  );
  const bars = seconds - lowerSeconds <= upperSeconds - seconds ? lower : upper;
  if (!Number.isInteger(bars) || bars < 1 || bars > 256) {
    durationError.value = g.value.lengthInvalid;
    return;
  }
  setWholeBars(bars);
  input.value = formatDuration(wholeDuration.value);
}

// --- Length basis --------------------------------------------------------------

/** Chord progression length in whole bars (0 when there is no chord track). */
const chordProgressionBars = computed(() => {
  const end = store.chords.reduce((max, chord) => Math.max(max, chord.endPpq), 0);
  return Math.max(0, Math.round(barsBetweenPpq(store.timeSignatures, 0, end)));
});

/** Active editable MIDI clip (enables motif's clip targets). */
const activeMidiClip = computed(() => {
  const clip = store.activeClip;
  const track = clip ? store.tracks.find((entry) => entry.id === clip.trackId) : null;
  return clip !== null && clipKind(clip) === 'midi' && track?.frozen === undefined ? clip : null;
});

/** True when the active editable MIDI clip belongs to a percussion track (no motif target). */
const activeClipIsDrum = computed(() => {
  const clip = activeMidiClip.value;
  if (clip === null) return false;
  return isDrumTrack(
    store.tracks.find((entry) => entry.id === clip.trackId),
    clip.notes,
  );
});

/** Active MIDI clip used as the counter-melody source, including frozen clips. */
const counterSourceClip = computed(() => {
  const clip = store.activeClip;
  return clip !== null && clipKind(clip) === 'midi' ? clip : null;
});

/** True when the counter-melody source clip belongs to a percussion track. */
const counterSourceIsDrum = computed(() => {
  const clip = counterSourceClip.value;
  if (clip === null) return false;
  const track = store.tracks.find((entry) => entry.id === clip.trackId);
  return isDrumTrack(track, clip.notes);
});

/** Active MIDI clip's melody length in bars, or null when none is active. */
const counterBars = computed(() => {
  const clip = counterSourceClip.value;
  if (clip === null || counterSourceIsDrum.value) return null;
  const track = store.tracks.find((entry) => entry.id === clip.trackId);
  const projected = projectMidiNoteOccurrences(clip);
  const notes = track === undefined ? projected : harmonicNotes(track, projected);
  if (notes.length === 0) return null;
  const end = notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
  return Math.max(1, Math.round(barsBetweenPpq(store.timeSignatures, 0, end)));
});

const hasChords = computed(() => store.chords.length > 0);
const hasEditableMidiClip = computed(() =>
  store.clips.some((clip) => {
    if (clipKind(clip) !== 'midi') return false;
    const track = store.tracks.find((entry) => entry.id === clip.trackId);
    return track?.frozen === undefined;
  }),
);
/** A melody clip is enough to open the motif/drum/counter workflow without chords. */
const hasGeneratorSource = computed(() => hasChords.value || hasEditableMidiClip.value);
const counterAvailable = computed(() => counterBars.value !== null);

/** Why a part cannot be generated right now, or null when it can. */
function partBlocked(part: TrackPart): string | null {
  return firstBlock(
    [!hasChords.value && (part === 'bass' || part === 'backing'), g.value.chordsRequired],
    [part === 'counter' && counterSourceIsDrum.value, g.value.counterDrumSource],
    [part === 'counter' && !counterAvailable.value, g.value.counterUnavailable],
  );
}

function isPartAvailable(part: TrackPart): boolean {
  return partBlocked(part) === null;
}

// --- Part parameters -----------------------------------------------------------

type MotifContour = 'arch' | 'ascending' | 'descending' | 'wave';
const CONTOURS: ReadonlyArray<{
  id: MotifContour;
  labelKey: 'contourArch' | 'contourAscending' | 'contourDescending' | 'contourWave';
}> = [
  { id: 'arch', labelKey: 'contourArch' },
  { id: 'ascending', labelKey: 'contourAscending' },
  { id: 'descending', labelKey: 'contourDescending' },
  { id: 'wave', labelKey: 'contourWave' },
];
const motifBars = ref(2);
const motifBarsDirty = ref(false);
const motifContour = ref<MotifContour>('arch');
const motifDevelop = ref(true);

type GrooveId =
  | 'standard'
  | 'funk'
  | 'shuffle'
  | 'bossa'
  | 'trap'
  | 'halftime'
  | 'breakbeat'
  | 'house'
  | 'synthpop';
const GROOVES: ReadonlyArray<{
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
type SectionId = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro';
const SECTIONS: ReadonlyArray<{
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
const drumStyle = ref<GrooveId>('standard');
const drumSection = ref<SectionId>('verse');
const drumNextSection = ref<SectionId | 'same'>('same');
const drumBars = ref(4);
const drumBarsDirty = ref(false);
const drumDensity = ref(0.6);
const drumFills = ref(true);
/**
 * Playing-difficulty ceiling for the groove; 0 means none. It rejects strokes
 * the density asked for and the tempo makes too fast to sustain, so it thins a
 * fast groove more than a slow one, and the two dials are not interchangeable.
 */
const drumDifficulty = ref(0);
const DRUM_DIFFICULTIES: ReadonlyArray<number> = Array.from(
  { length: MAX_DRUM_DIFFICULTY - MIN_DRUM_DIFFICULTY + 1 },
  (_unused, index) => MIN_DRUM_DIFFICULTY + index,
);

/** Range controls used only when a drum track's existing material is targeted. */
const DRUM_RANGE_MANUAL = 'manual';
const drumRangeStartBar = ref(1);
const drumRangeLengthBars = ref(4);
const drumRangeSectionId = ref(DRUM_RANGE_MANUAL);

interface SavedDrumSection {
  id: number;
  name: string;
  startBar: number;
  lengthBars: number;
}

/** Saved arrangement sections that can be addressed on the generator's 4/4 grid. */
const savedDrumSections = computed<ReadonlyArray<SavedDrumSection>>(() =>
  store.sections.flatMap((section) => {
    const startBar = barNumberAt(store.timeSignatures, section.startPpq);
    const spanBars = barsBetweenPpq(store.timeSignatures, section.startPpq, section.endPpq);
    const lengthBars = Math.round(spanBars);
    if (
      barStartPpq(store.timeSignatures, startBar) !== section.startPpq ||
      Math.abs(spanBars - lengthBars) > 1e-9 ||
      startBar < 1 ||
      lengthBars < 1 ||
      !isFourFourBarRange(store.timeSignatures, section.startPpq, lengthBars)
    ) {
      return [];
    }
    return [
      {
        id: section.id,
        name: section.name.trim() || formatMessage(g.value.rangeUnnamedSection, { id: section.id }),
        startBar,
        lengthBars,
      },
    ];
  }),
);

type BassStyle = 'root' | 'rootFifth' | 'pop' | 'walking' | 'arpeggio';
const BASS_STYLES: ReadonlyArray<{
  id: BassStyle;
  labelKey: 'bassRoot' | 'bassRootFifth' | 'bassPop' | 'bassWalking' | 'bassArpeggio';
}> = [
  { id: 'root', labelKey: 'bassRoot' },
  { id: 'rootFifth', labelKey: 'bassRootFifth' },
  { id: 'pop', labelKey: 'bassPop' },
  { id: 'walking', labelKey: 'bassWalking' },
  { id: 'arpeggio', labelKey: 'bassArpeggio' },
];
const bassStyle = ref<BassStyle>('root');

const counterRegister = ref<'above' | 'below'>('below');
const counterRhythm = ref<'complement' | 'follow'>('complement');

type BackingStyleId = 'smooth' | 'close' | 'drop2' | 'drop3' | 'shell' | 'rootless';
const BACKING_STYLES: ReadonlyArray<{
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
const backingStyle = ref<BackingStyleId>('smooth');

// --- Length seeding (drums/motif default to the chord-progression length) ------

/** Re-seeds drums/motif bars from the progression length until manually edited. */
function reseedBars(): void {
  const bars = chordProgressionBars.value || counterBars.value || 4;
  if (bars > 0) {
    if (!wholeBarsDirty.value) wholeBars.value = bars;
    if (!drumBarsDirty.value) drumBars.value = wholeBars.value;
    if (!motifBarsDirty.value) motifBars.value = wholeBars.value;
  }
}

watch(chordProgressionBars, reseedBars);
watch(counterBars, reseedBars);
watch(counterAvailable, (available) => {
  if (!available) {
    parts.counter.checked = false;
    parts.counter.expanded = false;
  }
});

// --- Open / reset --------------------------------------------------------------

function resetState(): void {
  for (const id of PART_IDS) {
    parts[id].checked = false;
    parts[id].expanded = false;
    parts[id].target = 'new';
  }
  error.value = null;
  done.value = false;
  drumBarsDirty.value = false;
  motifBarsDirty.value = false;
  wholeBarsDirty.value = false;
  durationError.value = null;
  drumNextSection.value = 'same';
  drumRangeStartBar.value = 1;
  drumRangeLengthBars.value = 4;
  drumRangeSectionId.value = DRUM_RANGE_MANUAL;
  reseedBars();
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    resetState();
    const openWith = props.openWith;
    if (openWith) {
      const state = parts[openWith.part];
      state.checked = isPartAvailable(openWith.part);
      state.expanded = isPartAvailable(openWith.part);
      const target = encodeTarget(openWith.target);
      if (targetOptions(openWith.part).some((option) => option.value === target)) {
        state.target = target;
      } else {
        state.target = 'new';
        error.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
      }
      if (!isPartAvailable(openWith.part)) error.value = g.value.counterUnavailable;
    } else {
      // The normal path is the quick beginner flow: generate a usable
      // accompaniment first, then continue into the lead composer. Keep
      // regeneration focused on the requested part via the branch above.
      if (!hasChords.value && hasEditableMidiClip.value) applyPreset(['motif']);
      else presetAccompaniment();
    }
  },
  { immediate: true },
);

// --- Targets -------------------------------------------------------------------

function targetTrackId(value: string, prefix: 'replace' | 'range'): number | null {
  if (!value.startsWith(`${prefix}:`)) return null;
  const trackId = Number(value.slice(prefix.length + 1));
  return Number.isInteger(trackId) && trackId >= 0 ? trackId : null;
}

const drumRangeTrackId = computed(() => targetTrackId(parts.drums.target, 'range'));
const isDrumRangeTarget = computed(() => drumRangeTrackId.value !== null);

const drumRangeStartPpq = computed(() =>
  barStartPpq(store.timeSignatures, Math.round(drumRangeStartBar.value)),
);
const drumRangeEndPpq = computed(() =>
  advanceBarsPpq(
    store.timeSignatures,
    drumRangeStartPpq.value,
    Math.round(drumRangeLengthBars.value),
  ),
);

const drumRangeTargetClipEndPpq = computed(() => {
  const trackId = drumRangeTrackId.value;
  if (trackId === null) return 0;
  return store.clips
    .filter((clip) => clip.trackId === trackId)
    .reduce((end, clip) => Math.max(end, clip.startPpq + clip.lengthPpq), 0);
});
const drumRangeTargetClipStartPpq = computed(() => {
  const trackId = drumRangeTrackId.value;
  if (trackId === null) return 0;
  const starts = store.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => clip.startPpq);
  return starts.length === 0 ? 0 : Math.min(...starts);
});

/** A translated, actionable validation message shown before the command runs. */
const drumRangeValidation = computed(() => {
  if (!isDrumRangeTarget.value) return null;
  const start = drumRangeStartBar.value;
  const length = drumRangeLengthBars.value;
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(length) || length < 1) {
    return g.value.rangeInvalid;
  }
  if (!isFourFourBarRange(store.timeSignatures, drumRangeStartPpq.value, length)) {
    return g.value.rangeMeterError;
  }
  const clipStart = drumRangeTargetClipStartPpq.value;
  if (clipStart > 0 && drumRangeStartPpq.value < clipStart) {
    return formatMessage(g.value.rangeBeforeTrack, {
      start: barNumberAt(store.timeSignatures, clipStart),
    });
  }
  const clipEnd = drumRangeTargetClipEndPpq.value;
  if (clipEnd > 0 && drumRangeEndPpq.value > clipEnd) {
    return formatMessage(g.value.rangeOutsideTrack, {
      end: Math.round(barsBetweenPpq(store.timeSignatures, 0, clipEnd)),
    });
  }
  const intersecting = store.clips.filter(
    (clip) =>
      clip.trackId === drumRangeTrackId.value &&
      clipKind(clip) === 'midi' &&
      clip.startPpq < drumRangeEndPpq.value &&
      clip.startPpq + clip.lengthPpq > drumRangeStartPpq.value,
  );
  const targetClip = intersecting[0];
  if (
    intersecting.length !== 1 ||
    targetClip === undefined ||
    targetClip.startPpq > drumRangeStartPpq.value ||
    targetClip.startPpq + targetClip.lengthPpq < drumRangeEndPpq.value
  ) {
    return g.value.rangeSingleClip;
  }
  if (targetClip.loopEnabled) return g.value.rangeLoopedClip;
  return null;
});

function onDrumRangeSectionChange(): void {
  if (drumRangeSectionId.value === DRUM_RANGE_MANUAL) return;
  const sectionId = Number(drumRangeSectionId.value.slice('section:'.length));
  const section = savedDrumSections.value.find((entry) => entry.id === sectionId);
  if (section === undefined) {
    drumRangeSectionId.value = DRUM_RANGE_MANUAL;
    return;
  }
  drumRangeStartBar.value = section.startBar;
  drumRangeLengthBars.value = section.lengthBars;
  applyDrumSectionContext(
    barStartPpq(store.timeSignatures, section.startBar),
    barStartPpq(store.timeSignatures, section.startBar + section.lengthBars),
  );
}

function onTargetChanged(part: TrackPart): void {
  if (part === 'drums' && isDrumRangeTarget.value) {
    // Selecting a range target immediately exposes the scope controls so a
    // user never has to guess which part of the track will be overwritten.
    parts.drums.expanded = true;
  }
}

/** Maps common section names to the generator's section shaping presets. */
function sectionIdFromName(name: string): SectionId | null {
  const normalized = name.trim().toLocaleLowerCase();
  if (/(pre.?chorus|prechorus|bメロ|サビ前)/u.test(normalized)) return 'prechorus';
  if (/(chorus|hook|サビ)/u.test(normalized)) return 'chorus';
  if (/(intro|イントロ)/u.test(normalized)) return 'intro';
  if (/(verse|aメロ)/u.test(normalized)) return 'verse';
  if (/(bridge|間奏|ブリッジ)/u.test(normalized)) return 'bridge';
  if (/(outro|エンディング|アウトロ)/u.test(normalized)) return 'outro';
  return null;
}

/** Loads the saved section's style and its following section into drum controls. */
function applyDrumSectionContext(startPpq: number, endPpq: number): void {
  const section = store.sections.find(
    (entry) => entry.startPpq === startPpq && entry.endPpq === endPpq,
  );
  if (section === undefined) return;

  const sectionId = sectionIdFromName(section.name);
  if (sectionId !== null) drumSection.value = sectionId;

  const next = store.sections.find((entry) => entry.startPpq === endPpq);
  const nextId = next === undefined ? null : sectionIdFromName(next.name);
  drumNextSection.value = nextId ?? (sectionId === 'prechorus' ? 'chorus' : 'same');

  const saved = savedDrumSections.value.find((entry) => entry.id === section.id);
  drumRangeSectionId.value = saved === undefined ? DRUM_RANGE_MANUAL : `section:${section.id}`;
}

function encodeTarget(target: BatchTarget): string {
  if (target.kind === 'new') return 'new';
  if (target.kind === 'replaceTrack') return `replace:${target.trackId}`;
  if (target.kind === 'replaceRange') {
    drumRangeStartBar.value = barNumberAt(store.timeSignatures, target.startPpq);
    drumRangeLengthBars.value = Math.max(
      1,
      Math.round(barsBetweenPpq(store.timeSignatures, target.startPpq, target.endPpq)),
    );
    applyDrumSectionContext(target.startPpq, target.endPpq);
    return `range:${target.trackId}`;
  }
  return `clip:${target.mode}`;
}

function decodeTarget(value: string): BatchTarget {
  if (value.startsWith('replace:')) {
    return { kind: 'replaceTrack', trackId: Number(value.slice('replace:'.length)) };
  }
  const rangeTrackId = targetTrackId(value, 'range');
  if (rangeTrackId !== null) {
    return {
      kind: 'replaceRange',
      trackId: rangeTrackId,
      startPpq: drumRangeStartPpq.value,
      endPpq: drumRangeEndPpq.value,
    };
  }
  if (value === 'clip:append') return { kind: 'clip', mode: 'append' };
  if (value === 'clip:replace') return { kind: 'clip', mode: 'replace' };
  return { kind: 'new' };
}

/** Replacement candidates for a part: tracks recorded as (or named after) it. */
function replaceCandidates(part: TrackPart): { value: string; label: string }[] {
  const matching = store.tracks.filter(
    (track) => track.frozen === undefined && partForTrack(track) === part,
  );
  // Empty MIDI lanes are useful in a prepared arrangement (for example
  // Soprano/Tenor/Pedal in an organ template). Offer them after a known part,
  // while never stealing a hand-authored lane that already contains notes.
  const emptyMidi = store.tracks.filter(
    (track) =>
      track.frozen === undefined &&
      track.kind === 'midi' &&
      partForTrack(track) === null &&
      store.clips
        .filter((clip) => clip.trackId === track.id && clipKind(clip) === 'midi')
        .every((clip) => clip.notes.length === 0),
  );
  return [...matching, ...emptyMidi].map((track) => ({
    value: `replace:${track.id}`,
    label: formatMessage(g.value.targetReplace, { name: track.name }),
  }));
}

/** Full target dropdown for a part. */
function targetOptions(part: TrackPart): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: 'new', label: g.value.targetNew }];
  if (part === 'motif' && activeMidiClip.value !== null && !activeClipIsDrum.value) {
    options.push(
      { value: 'clip:append', label: g.value.targetClipAppend },
      { value: 'clip:replace', label: g.value.targetClipReplace },
    );
  }
  const replacements = replaceCandidates(part);
  options.push(...replacements);
  if (part === 'drums') {
    for (const track of editableDrumTracks(store.tracks, store.clips)) {
      options.push({
        value: `range:${track.id}`,
        label: formatMessage(g.value.targetReplaceRange, { name: track.name }),
      });
    }
  }
  return options;
}

// --- Derived checklist state ---------------------------------------------------

const selectedCount = computed(
  () => PART_IDS.filter((id) => parts[id].checked && isPartAvailable(id)).length,
);

/** Parts that will create a track of their own. */
const newTrackCount = computed(
  () =>
    PART_IDS.filter(
      (id) =>
        parts[id].checked && isPartAvailable(id) && decodeTarget(parts[id].target).kind === 'new',
    ).length,
);

/** Why Generate cannot run: nothing ticked, a run in flight, or an invalid field. */
const generateBlocked = computed(() =>
  firstBlock(
    [selectedCount.value === 0, g.value.noPartSelected],
    [generating.value, t.value.reasons.busy],
    [
      store.tracks.length + newTrackCount.value > MAX_TRACK_LANES,
      formatMessage(t.value.reasons.trackLimit, { limit: MAX_TRACK_LANES }),
    ],
    partBarsError.value,
    appliesWholeLength.value ? wholeLengthError.value : null,
    parts.drums.checked ? drumRangeValidation.value : null,
  ),
);

const partBarsError = computed(() => {
  const invalid = (bars: number) => !Number.isInteger(bars) || bars < 1 || bars > 256;
  if (parts.motif.checked && isPartAvailable('motif') && invalid(motifBars.value)) {
    return g.value.partLengthInvalid;
  }
  if (
    parts.drums.checked &&
    isPartAvailable('drums') &&
    !isDrumRangeTarget.value &&
    invalid(drumBars.value)
  ) {
    return g.value.partLengthInvalid;
  }
  return null;
});

const midOverlap = computed(
  () =>
    PART_IDS.filter((id) => parts[id].checked && isPartAvailable(id) && MID_RANGE_PARTS.has(id))
      .length >= 2,
);

/** Result length in bars shown on a part row (null = clip-derived, unknown). */
function resultBarsOf(part: TrackPart): number | null {
  switch (part) {
    case 'drums':
      return isDrumRangeTarget.value
        ? Math.max(1, Math.round(drumRangeLengthBars.value))
        : Math.max(1, Math.round(drumBars.value));
    case 'motif':
      return Math.max(1, Math.round(motifBars.value));
    case 'bass':
    case 'backing':
      return usesWholeLength.value ? wholeBars.value : chordProgressionBars.value;
    case 'counter':
      return counterBars.value ?? chordProgressionBars.value;
  }
}

/** The "N bars" label on a part row, or empty when the length is unknown. */
function resultBarsText(part: TrackPart): string {
  const bars = resultBarsOf(part);
  if (bars === null) return '';
  return formatMessage(part === 'counter' ? g.value.sourceBars : g.value.resultBars, {
    count: bars,
  });
}

/** The trailing "→ …" hint on a part row, from its target. */
function resultTargetOf(part: TrackPart): string {
  const value = parts[part].target;
  if (value.startsWith('clip:')) return g.value.resultToClip;
  if (value.startsWith('range:')) return g.value.resultToRange;
  if (value.startsWith('replace:')) return g.value.resultToReplace;
  return g.value.resultToNew;
}

// --- Presets -------------------------------------------------------------------

function applyPreset(ids: readonly TrackPart[]): void {
  for (const id of PART_IDS) parts[id].checked = ids.includes(id) && isPartAvailable(id);
}

function presetAccompaniment(): void {
  applyPreset(['drums', 'bass', 'backing']);
}

function presetAll(): void {
  applyPreset(PART_IDS);
}

function presetClear(): void {
  applyPreset([]);
}

// --- Generate ------------------------------------------------------------------

function paramsFor(part: TrackPart): BatchPartSpec['params'] {
  switch (part) {
    case 'motif':
      return {
        bars: motifBars.value,
        contour: motifContour.value,
        develop: motifDevelop.value,
        seed: seedFor('motif'),
      };
    case 'drums':
      return {
        bars: drumBars.value,
        style: drumStyle.value,
        section: drumSection.value,
        density: clamp01(drumDensity.value),
        fills: drumFills.value,
        ...(drumNextSection.value !== 'same' ? { nextSection: drumNextSection.value } : {}),
        ...(drumDifficulty.value > 0 ? { difficulty: drumDifficulty.value } : {}),
        seed: seedFor('drums'),
      };
    case 'bass':
      return { style: bassStyle.value, seed: seedFor('bass') };
    case 'counter':
      return {
        register: counterRegister.value,
        rhythm: counterRhythm.value,
        profile: toSafetyProfile(appSettings.settings.guidanceProfile),
        seed: seedFor('counter'),
      };
    case 'backing':
      return { style: backingStyle.value };
  }
}

function buildSpecs(): BatchPartSpec[] {
  const specs: BatchPartSpec[] = [];
  for (const part of PART_IDS) {
    if (!parts[part].checked || !isPartAvailable(part)) continue;
    const target = decodeTarget(parts[part].target);
    specs.push({ part, params: paramsFor(part), target } as BatchPartSpec);
  }
  return specs;
}

function onCancel(): void {
  emit('close');
}

function onGenerate(): void {
  if (selectedCount.value === 0 || generating.value) return;
  if (partBarsError.value !== null) {
    error.value = partBarsError.value;
    return;
  }
  if (appliesWholeLength.value && wholeLengthError.value !== null) {
    error.value = wholeLengthError.value;
    return;
  }
  if (parts.drums.checked && drumRangeValidation.value !== null) {
    error.value = drumRangeValidation.value;
    return;
  }
  error.value = null;
  generating.value = true;
  try {
    const written = generateTracksBatchCommand(
      buildSpecs(),
      appliesWholeLength.value ? { targetBars: wholeBars.value } : undefined,
    );
    const isRegeneration = props.openWith !== null && props.openWith !== undefined;
    if (written > 0 && !isRegeneration) done.value = true;
    else if (written > 0) emit('close');
    else error.value = g.value.error;
  } catch (e) {
    error.value = describeError(e, t.value.notices.errors);
  } finally {
    generating.value = false;
  }
}

function onComposeLead(): void {
  error.value = null;
  try {
    const clipId = createLeadMelodyCommand(g.value.leadName);
    if (clipId === null) {
      error.value = g.value.leadError;
      return;
    }
    emit('composeLead');
  } catch (e) {
    error.value = describeError(e, t.value.notices.errors);
  }
}

function toggleExpanded(part: TrackPart): void {
  if (!isPartAvailable(part)) return;
  parts[part].expanded = !parts[part].expanded;
}
</script>

<template>
  <AppModal :open="props.open" size="md" :aria-label="g.title" @close="onCancel">
    <template #title>{{ g.title }}</template>

    <div v-if="!hasGeneratorSource" class="gate">
      <p class="gate-title">{{ g.gateTitle }}</p>
      <p class="gate-body">{{ g.gateBody }}</p>
    </div>

    <div v-else-if="done" class="track-done">
      <div class="chord-summary">
        <span class="chord-summary-label">{{ g.chordSummaryLabel }}</span>
        <span v-if="hasChords" class="chord-summary-bars">{{
          formatMessage(g.chordBars, { count: chordProgressionBars })
        }}</span>
        <span v-else class="chord-summary-bars">{{ g.noChordsSummary }}</span>
      </div>
      <div class="done-message">
        <svg class="done-badge animate-pop" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="9" />
          <path d="M6 10.4l2.6 2.6L14 7.6" />
        </svg>
        <p class="done-title">{{ g.doneTitle }}</p>
        <p class="done-body">{{ hasChords ? g.doneBody : g.doneBodyNoChords }}</p>
      </div>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <div v-else class="track-fields">
      <div class="chord-summary">
        <span class="chord-summary-label">{{ g.chordSummaryLabel }}</span>
        <span v-if="hasChords" class="chord-summary-bars">{{
          formatMessage(g.chordBars, { count: chordProgressionBars })
        }}</span>
        <span v-else class="chord-summary-bars">{{ g.noChordsSummary }}</span>
        <button type="button" class="edit-chords" @click="emit('openChords')">
          {{ g.editChords }}
        </button>
      </div>

      <div v-if="usesWholeLength" class="whole-length">
        <span class="field-label">{{ g.lengthTitle }}</span>
        <div class="whole-length-fields">
          <label class="number-field">
            <span class="field-label">{{ g.bars }}</span>
            <input
              :value="wholeBars"
              class="whole-bars-input"
              type="number"
              min="1"
              max="256"
              step="1"
              @input="onWholeBarsInput"
            />
          </label>
          <label class="number-field">
            <span class="field-label">{{ g.lengthTime }}</span>
            <input
              :value="formatDuration(wholeDuration)"
              class="whole-time-input"
              type="text"
              inputmode="numeric"
              placeholder="3:00"
              @change="onDurationChange"
            />
          </label>
        </div>
        <p class="whole-length-note">{{
          formatMessage(g.lengthActual, { duration: formatDuration(wholeDuration) })
        }}</p>
        <p class="whole-length-note">{{ g.lengthScope }}</p>
        <p v-if="appliesWholeLength && hasChords && wholeBars > chordProgressionBars" class="whole-length-note">
          {{ formatMessage(g.lengthRepeatChords, { count: wholeBars }) }}
        </p>
        <p v-else-if="appliesWholeLength && hasChords && wholeBars < chordProgressionBars" class="whole-length-note">
          {{ formatMessage(g.lengthTrimChords, { count: wholeBars }) }}
        </p>
        <p v-if="appliesWholeLength && wholeLengthError" class="dialog-error" role="alert">{{ wholeLengthError }}</p>
      </div>

      <div class="seed-row">
        <label class="number-field">
          <span class="field-label">{{ g.projectSeed }}</span>
          <input v-model.number="projectSeed" type="number" min="0" step="1" />
        </label>
        <span class="seed-caption">{{ g.projectSeedCaption }}</span>
      </div>

      <div class="preset-row">
        <span class="field-label">{{ g.presetsLabel }}</span>
        <div class="preset-buttons">
          <button
            type="button"
            class="preset-chip"
            v-tooltip="g.presetAccompanimentTitle"
            @click="presetAccompaniment"
          >
            {{ g.presetAccompaniment }}
          </button>
          <button type="button" class="preset-chip" v-tooltip="g.presetAllTitle" @click="presetAll">
            {{ g.presetAll }}
          </button>
          <button
            type="button"
            class="preset-chip"
            v-tooltip="g.presetClearTitle"
            @click="presetClear"
          >
            {{ g.presetClear }}
          </button>
        </div>
      </div>

      <div class="part-list">
        <div
          v-for="part in PART_IDS"
          :key="part"
          class="part-row"
          :class="{ checked: parts[part].checked }"
        >
          <div class="part-head">
            <label
              class="part-check"
              :class="{ disabled: !isPartAvailable(part) }"
              v-tooltip="{ reason: partBlocked(part) }"
            >
              <input
                v-model="parts[part].checked"
                type="checkbox"
                :disabled="!isPartAvailable(part)"
                :aria-describedby="!isPartAvailable(part) ? `part-disabled-${part}` : undefined"
              />
              <span class="part-name">{{ g[PART_LABEL_KEYS[part]] }}</span>
            </label>
            <span class="part-role">{{ g[PART_ROLE_KEYS[part]] }}</span>
            <span class="part-result">
              <span>{{ resultBarsText(part) }}</span>
              <span class="part-result-target">{{ resultTargetOf(part) }}</span>
            </span>
            <select
              v-model="parts[part].target"
              class="part-target"
              :disabled="!isPartAvailable(part)"
              v-tooltip="{ text: g.targetTitle, reason: partBlocked(part) }"
              @change="onTargetChanged(part)"
            >
              <option v-for="option in targetOptions(part)" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <button
              type="button"
              class="part-expand"
              :aria-expanded="parts[part].expanded"
              :disabled="!isPartAvailable(part)"
              v-tooltip="{ text: g.detailsTitle, reason: partBlocked(part) }"
              @click="toggleExpanded(part)"
            >
              {{ g.details }}
            </button>
          </div>
          <p
            v-if="!isPartAvailable(part)"
            :id="`part-disabled-${part}`"
            class="part-disabled-hint"
          >
            {{ partBlocked(part) }}
          </p>

          <div v-if="parts[part].expanded" class="part-params">
            <template v-if="part === 'motif'">
              <span class="field-label">{{ g.contour }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.contour">
                <button
                  v-for="option in CONTOURS"
                  :key="option.id"
                  type="button"
                  class="segment"
                  :class="{ active: motifContour === option.id }"
                  role="radio"
                  :aria-checked="motifContour === option.id"
                  @click="motifContour = option.id"
                >
                  {{ g[option.labelKey] }}
                </button>
              </div>
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.bars }}</span>
                  <input
                    v-model.number="motifBars"
                    type="number"
                    min="1"
                    max="256"
                    step="1"
                    @input="motifBarsDirty = true"
                  />
                  <span class="bars-caption">{{
                    formatMessage(g.barsCaption, { count: chordProgressionBars })
                  }}</span>
                </label>
                <div class="reroll-field">
                  <span class="field-label">{{ g.variation }}</span>
                  <button
                    type="button"
                    class="reroll-button"
                    v-tooltip="g.rerollTitle"
                    @click="reroll('motif')"
                  >
                    {{ g.reroll }}
                  </button>
                  <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.motif.reroll + 1 }) }}</span>
                </div>
              </div>
              <label class="check-label">
                <input v-model="motifDevelop" type="checkbox" />
                {{ g.develop }}
              </label>
            </template>

            <template v-else-if="part === 'drums'">
              <div v-if="isDrumRangeTarget" class="drum-range-panel">
                <div class="drum-range-heading">
                  <span class="field-label">{{ g.rangeTitle }}</span>
                  <span class="drum-range-preserve">{{ g.rangePreserve }}</span>
                </div>
                <p class="drum-range-hint">{{ g.rangeHint }}</p>
                <label v-if="savedDrumSections.length > 0" class="number-field saved-range-field">
                  <span class="field-label">{{ g.rangeSection }}</span>
                  <select v-model="drumRangeSectionId" @change="onDrumRangeSectionChange">
                    <option :value="DRUM_RANGE_MANUAL">{{ g.rangeManual }}</option>
                    <option
                      v-for="section in savedDrumSections"
                      :key="section.id"
                      :value="`section:${section.id}`"
                    >
                      {{
                        formatMessage(g.rangeSectionOption, {
                          name: section.name,
                          start: section.startBar,
                          end: section.startBar + section.lengthBars - 1,
                        })
                      }}
                    </option>
                  </select>
                </label>
                <div class="number-row drum-range-numbers">
                  <label class="number-field">
                    <span class="field-label">{{ g.rangeStart }}</span>
                    <input
                      v-model.number="drumRangeStartBar"
                      class="drum-range-start"
                      type="number"
                      min="1"
                      step="1"
                      @input="drumRangeSectionId = DRUM_RANGE_MANUAL"
                    />
                  </label>
                  <label class="number-field">
                    <span class="field-label">{{ g.rangeLength }}</span>
                    <input
                      v-model.number="drumRangeLengthBars"
                      class="drum-range-length"
                      type="number"
                      min="1"
                      max="128"
                      step="1"
                      @input="drumRangeSectionId = DRUM_RANGE_MANUAL"
                    />
                  </label>
                </div>
                <p class="drum-range-summary">
                  {{
                    formatMessage(g.rangeSummary, {
                      start: drumRangeStartBar,
                      end: drumRangeStartBar + drumRangeLengthBars - 1,
                    })
                  }}
                </p>
                <p v-if="drumRangeValidation" class="dialog-error drum-range-error" role="alert">
                  {{ drumRangeValidation }}
                </p>
              </div>
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.grooveStyle }}</span>
                  <select v-model="drumStyle" class="drum-style">
                    <option v-for="option in GROOVES" :key="option.id" :value="option.id">
                      {{ g[option.labelKey] }}
                    </option>
                  </select>
                </label>
                <label class="number-field">
                  <span class="field-label">{{ g.section }}</span>
                  <select v-model="drumSection" class="drum-section-type">
                    <option v-for="option in SECTIONS" :key="option.id" :value="option.id">
                      {{ g[option.labelKey] }}
                    </option>
                  </select>
                </label>
                <label class="number-field">
                  <span class="field-label">{{ g.nextSection }}</span>
                  <select v-model="drumNextSection" class="drum-next-section">
                    <option value="same">{{ g.nextSectionSame }}</option>
                    <option v-for="option in SECTIONS" :key="`next-${option.id}`" :value="option.id">
                      {{ g[option.labelKey] }}
                    </option>
                  </select>
                </label>
                <label class="number-field difficulty-field">
                  <span class="field-label">{{ g.difficulty }}</span>
                  <select v-model.number="drumDifficulty" v-tooltip="g.difficultyTitle">
                    <option :value="0">{{ g.difficultyNone }}</option>
                    <option v-for="level in DRUM_DIFFICULTIES" :key="level" :value="level">
                      {{ level }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.bars }}</span>
                  <input
                    v-model.number="drumBars"
                    type="number"
                    min="1"
                    max="256"
                    step="1"
                    @input="drumBarsDirty = true"
                  />
                  <span class="bars-caption">{{
                    formatMessage(g.barsCaption, { count: chordProgressionBars })
                  }}</span>
                </label>
                <label class="number-field">
                  <span class="field-label">{{ g.density }}</span>
                  <input
                    v-model.number="drumDensity"
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    v-tooltip="g.densityTitle"
                  />
                </label>
                <div class="reroll-field">
                  <span class="field-label">{{ g.variation }}</span>
                  <button
                    type="button"
                    class="reroll-button"
                    v-tooltip="g.rerollTitle"
                    @click="reroll('drums')"
                  >
                    {{ g.reroll }}
                  </button>
                  <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.drums.reroll + 1 }) }}</span>
                </div>
              </div>
              <label class="check-label">
                <input v-model="drumFills" type="checkbox" />
                {{ g.fills }}
              </label>
            </template>

            <template v-else-if="part === 'bass'">
              <span class="field-label">{{ g.bassStyle }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.bassStyle">
                <button
                  v-for="option in BASS_STYLES"
                  :key="option.id"
                  type="button"
                  class="segment"
                  :class="{ active: bassStyle === option.id }"
                  role="radio"
                  :aria-checked="bassStyle === option.id"
                  @click="bassStyle = option.id"
                >
                  {{ g[option.labelKey] }}
                </button>
              </div>
              <div class="reroll-field">
                <span class="field-label">{{ g.variation }}</span>
                <button
                    type="button"
                    class="reroll-button"
                    v-tooltip="g.rerollTitle"
                    @click="reroll('bass')"
                  >
                  {{ g.reroll }}
                </button>
                <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.bass.reroll + 1 }) }}</span>
              </div>
            </template>

            <template v-else-if="part === 'counter'">
              <span class="field-label">{{ g.register }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.register">
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRegister === 'above' }"
                  role="radio"
                  :aria-checked="counterRegister === 'above'"
                  @click="counterRegister = 'above'"
                >
                  {{ g.registerAbove }}
                </button>
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRegister === 'below' }"
                  role="radio"
                  :aria-checked="counterRegister === 'below'"
                  @click="counterRegister = 'below'"
                >
                  {{ g.registerBelow }}
                </button>
              </div>
              <span class="field-label">{{ g.rhythm }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.rhythm">
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRhythm === 'complement' }"
                  role="radio"
                  :aria-checked="counterRhythm === 'complement'"
                  @click="counterRhythm = 'complement'"
                >
                  {{ g.rhythmComplement }}
                </button>
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRhythm === 'follow' }"
                  role="radio"
                  :aria-checked="counterRhythm === 'follow'"
                  @click="counterRhythm = 'follow'"
                >
                  {{ g.rhythmFollow }}
                </button>
              </div>
              <div class="reroll-field">
                <span class="field-label">{{ g.variation }}</span>
                <button
                    type="button"
                    class="reroll-button"
                    v-tooltip="g.rerollTitle"
                    @click="reroll('counter')"
                  >
                  {{ g.reroll }}
                </button>
                <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.counter.reroll + 1 }) }}</span>
              </div>
            </template>

            <template v-else-if="part === 'backing'">
              <label class="number-field">
                <span class="field-label">{{ g.backingStyle }}</span>
                <select v-model="backingStyle">
                  <option v-for="option in BACKING_STYLES" :key="option.id" :value="option.id">
                    {{ g[option.labelKey] }}
                  </option>
                </select>
              </label>
            </template>
          </div>
        </div>
      </div>

      <p v-if="midOverlap" class="collision-inline">{{ g.collisionMidOverlap }}</p>
      <p class="collision-note">{{ g.collisionNote }}</p>
      <p v-if="partBarsError" class="dialog-error" role="alert">{{ partBarsError }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <template v-if="!hasGeneratorSource">
        <button type="button" @click="onCancel">{{ t.common.cancel }}</button>
        <button type="button" class="primary gate-create" @click="emit('openChords')">
          {{ g.gateCreate }}
        </button>
      </template>
      <template v-else-if="done">
        <button type="button" @click="onCancel">{{ t.common.close }}</button>
        <button type="button" class="primary compose-lead" @click="onComposeLead">
          {{ g.composeLead }}
        </button>
      </template>
      <template v-else>
        <button type="button" @click="onCancel">{{ t.common.cancel }}</button>
        <button
          type="button"
          class="primary generate-confirm"
          :disabled="!!generateBlocked"
          v-tooltip="{ reason: generateBlocked }"
          @click="onGenerate"
        >
          {{
            selectedCount === 0
              ? g.generateEmpty
              : selectedCount === 1
                ? g.generateOne
                : formatMessage(g.generate, { count: selectedCount })
          }}
        </button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.track-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 24rem;
  min-height: min(22rem, 52vh);
  max-height: 60vh;
  overflow-y: auto;
}

.track-done {
  animation: view-enter var(--dur-2) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 24rem;
  min-height: min(22rem, 52vh);
}

.done-message {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: var(--sp-2);
}

/* Completion mark: springs in once so the finished state reads as an event. */
.done-badge {
  flex: none;
  width: 1.5rem;
  height: 1.5rem;
  fill: color-mix(in srgb, var(--success) 14%, transparent);
  stroke: var(--success);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.done-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.done-body {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* Header row: the chord-progression basis every part is written against. */
.chord-summary {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.chord-summary-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.chord-summary-bars {
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.edit-chords {
  margin-left: auto;
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-sm);
  cursor: pointer;
}

.edit-chords:hover {
  text-decoration: underline;
}

.whole-length {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-inset);
}

.whole-length-fields {
  display: flex;
  gap: var(--sp-3);
}

.whole-length-fields .number-field {
  flex: 1 1 0;
  min-width: 0;
}

.whole-length-note {
  margin: 0;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

/* The one number the whole arrangement is drawn from, above the part list so
 * it reads as a project setting rather than a per-part dial. */
.seed-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
}

.seed-row .number-field {
  flex: 0 0 10rem;
}

.seed-caption {
  padding-bottom: var(--sp-1);
  color: var(--text-3);
  font-size: var(--fs-xs);
}

/* A part is rerolled rather than given a seed of its own: the button bumps a
 * counter beneath the project seed, so the other parts keep what they had. */
.reroll-field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1 1 0;
}

.reroll-button {
  padding: var(--sp-1) var(--sp-3);
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.reroll-button:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.reroll-count {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.preset-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.preset-buttons {
  display: flex;
  gap: var(--sp-2);
}

.preset-chip {
  padding: var(--sp-1) var(--sp-3);
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.preset-chip:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.part-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* One part = a bordered card; checked cards carry the accent language (full
 * 1px border + light tint fill, no one-sided accent stripe). */
.part-row {
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.part-row.checked {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.part-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.part-check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
}

.part-check.disabled {
  cursor: not-allowed;
}

.part-check.disabled .part-name {
  color: var(--text-2);
}

.part-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.part-role {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-result {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-result-target {
  color: var(--text-3);
}

.part-disabled-hint {
  margin: var(--sp-2) 0 0 calc(1rem + var(--sp-2));
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-target {
  max-width: 12rem;
}

.part-expand {
  padding: var(--sp-1) var(--sp-2);
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.part-expand:hover {
  text-decoration: underline;
}

.part-params {
  animation: view-enter var(--dur-2) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.drum-range-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--surface-inset);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: var(--radius-sm);
}

.drum-range-heading {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.drum-range-preserve,
.drum-range-hint,
.drum-range-summary {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.saved-range-field {
  max-width: 22rem;
}

.drum-range-numbers {
  max-width: 22rem;
}

.drum-range-error {
  margin-top: var(--sp-1);
}

.number-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-5);
}

.number-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: 1 1 0;
  min-width: 8rem;
}

.number-field input,
.number-field select {
  width: 100%;
  box-sizing: border-box;
}

.bars-caption {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.check-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-md);
  color: var(--text-2);
}

.collision-inline {
  animation: view-enter var(--dur-2) var(--ease-out);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.collision-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.gate {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 22rem;
  min-height: 5rem;
}

.gate-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.gate-body {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.dialog-error {
  animation: view-enter var(--dur-2) var(--ease-out);
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 0;
}
</style>

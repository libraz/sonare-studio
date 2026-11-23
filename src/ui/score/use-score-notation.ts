import { defaultName } from '@/project/default-names';
/**
 * Non-destructive notation pipeline for the engraved score.
 *
 * Drives the display-only transcription: editor notes are quantized to a
 * NotatedScore (never written back to MIDI), optional chord symbols are
 * estimated, the score is serialized to MusicXML and engraved by the Verovio
 * worker. Display Quantize / layout changes only re-run this pipeline; the
 * project's note data is never touched.
 *
 * The composable owns the render state (svg, page count, loading/error) and the
 * latest MusicXML / timemap, plus the on-screen and print/export operations.
 * The Verovio worker client and the re-transcription watchers stay with the
 * caller, which passes the client in and threads the reactive inputs as
 * getters.
 */

import { computed, type Ref, ref, type ShallowRef, shallowRef } from 'vue';
import { confirmLossReport } from '@/composables/useLossConfirm';
import type { LossReport } from '@/export/loss-descriptor';
import { DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import { downloadBlob } from '@/lib/download';
import { errorMessage, isAbortError } from '@/lib/errors';
import { projectFilename } from '@/lib/filename';
import { clamp } from '@/lib/math';
import {
  OperationGeneration,
  type OperationIdentity,
  type OperationToken,
} from '@/lib/operation-generation';
import { PayloadMemoryMeter, type PayloadMemorySample, utf8ByteLength } from '@/lib/payload-memory';
import {
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import { exportMusicXml } from '@/notation/io';
import type { NotatedScore } from '@/notation/model';
import {
  extractPartsScore,
  inspectMusicXmlExportLoss,
  serializeMusicXml,
} from '@/notation/musicxml';
import { PdfTextFontUnavailableError } from '@/notation/pdf-font';
import {
  createPdfPageWriter,
  createPrintPageWriter,
  type PdfTextPlan,
  planPdfText,
} from '@/notation/print';
import { VerovioClient, type VerovioTimemapEntry } from '@/notation/verovio';
import { canonicalJson, fnv1a32Hex } from '@/project/hash';
import { type ProjectDocument, serializeProject } from '@/project/serialization';
import { clipKind, type TimeSignatureSegment } from '@/project/types';
import { useI18n } from '@/ui/i18n';
import {
  type ScoreLayoutSettings,
  scorePageDimsMm,
  scorePrintLayoutOptions,
  scoreScreenLayoutOptions,
} from '@/ui/score/layout';
import {
  applyKeySignatureMarks,
  applyLayoutBreaks,
  applyLyricMarks,
  applyMarkerTexts,
  applyMultiMeasureRests,
  applySectionMarks,
  applyTempoMarks,
  transposeChordSymbols,
  transposeKeyFifths,
} from '@/ui/score/score-marks';
import {
  buildFullScore,
  buildFullScoreProjection,
  buildScorePart,
  buildScoreProjection,
  chordEstimateNotes,
  fullScorePartTrackIds,
  type ProjectStore,
} from '@/ui/score/score-projection';

export {
  applyKeySignatureMarks,
  applyLayoutBreaks,
  applyLyricMarks,
  applyMarkerTexts,
  applyMultiMeasureRests,
  applySectionMarks,
  applyTempoMarks,
  transposeChordSymbols,
  transposeKeyFifths,
} from '@/ui/score/score-marks';
export {
  buildFullScore,
  buildFullScoreProjection,
  buildScorePart,
  buildScoreProjection,
  chordEstimateNotes,
  fullScorePartTrackIds,
  type ScorePartBuildOptions,
  type ScoreProjection,
} from '@/ui/score/score-projection';

/** Reactive inputs and collaborators the pipeline reads on every transcription. */
export interface ScoreNotationOptions {
  /** The project store (clip window, notes, annotations, transpose). */
  store: ProjectStore;
  /** Verovio worker client; created and disposed by the caller. */
  client: ShallowRef<VerovioClient | null>;
  /** Current Display Quantize grid step in PPQ. */
  getDivisionPpq: () => number;
  /** Time signature in effect at the clip start. */
  getTimeSig: () => { beats: number; beatUnit: number };
  /** Engraved measure length in PPQ for the clip's time signature. */
  getMeasureLenPpq: () => number;
  /** Clip length rendered on screen, rounded to complete measures, in PPQ. */
  getScreenClipLengthPpq: () => number;
  /** Project time-signature map used for measure-by-measure notation. */
  getTimeSignatures?: () => ReadonlyArray<TimeSignatureSegment>;
  /** Optional short opening measure imported from an anacrusis. */
  getPickupLengthPpq?: () => number;
  /** Key signature fifths derived from the scale highlight configuration. */
  getKeyFifths: () => number;
  /** True when chord symbols should be estimated and engraved. */
  getChordsEnabled: () => boolean;
  /** True when all overlapping MIDI tracks should be engraved as parts. */
  getFullScoreEnabled?: () => boolean;
  /** True when piano fingering should be estimated for engraved notes. */
  getEstimateFingering?: () => boolean;
  /** Grand-staff split pitch as MIDI note number (defaulted by quantizeToScore). */
  getGrandStaffSplitPitch?: () => number;
  /** Current layout settings (page, orientation, margins, scale, spacing). */
  getLayoutSettings: () => ScoreLayoutSettings;
  /** Resets the playhead highlight scan after every render / layout change. */
  resetPlayheadScan: () => void;
  /** Creates a replacement display client after a fatal worker failure. */
  createClient?: () => VerovioClient;
  /** Creates an isolated client for print/PDF rendering (injectable in tests). */
  createExportClient?: () => VerovioClient;
}

/**
 * The document as a MusicXML export engraves it: every track, or the active clip.
 * With `trackId` in Full Score mode, only that track (a single-part export).
 */
export function musicXmlScoredDocument(
  store: ProjectStore,
  fullScore: boolean,
  trackId?: number,
): ProjectDocument {
  const doc = serializeProject();
  if (fullScore) {
    if (trackId === undefined) return doc;
    const only = store.tracks.findIndex((track) => track.id === trackId);
    return { ...doc, tracks: doc.tracks[only] ? [doc.tracks[only]] : [] };
  }
  const clip = store.activeClip;
  const trackIndex = clip ? store.tracks.findIndex((track) => track.id === clip.trackId) : -1;
  const track = doc.tracks[trackIndex];
  if (!clip || !track) return { ...doc, tracks: [] };
  const clipIndex = store.clips
    .filter((entry) => entry.trackId === clip.trackId)
    .findIndex((entry) => entry.id === clip.id);
  const scored = track.clips[clipIndex];
  return { ...doc, tracks: [{ ...track, clips: scored ? [scored] : [] }] };
}

/** The notation surface bound by the score panel. */
export interface ScoreNotation {
  /** True while a render is in flight. */
  loading: Ref<boolean>;
  /** True while a print/export action is running. */
  exporting: Ref<boolean>;
  /** Last error message, or empty when none. */
  error: Ref<string>;
  /** The rendered SVG of the current page. */
  svg: Ref<string>;
  /** Current 1-based page number. */
  page: Ref<number>;
  /** Total page count of the loaded score. */
  pageCount: Ref<number>;
  /** Reads the loaded score's timemap (paired with the current SVG's ids). */
  getTimemap: () => ReadonlyArray<VerovioTimemapEntry>;
  /** Reads the MusicXML of the last successful transcription (export source). */
  getCurrentXml: () => string;
  /** Active track's part name when that part belongs to the current artifact. */
  getCurrentPartName: () => string;
  /** Bumps the render generation, optionally clearing every rendered artifact. */
  bumpGeneration: (clearArtifacts?: boolean) => void;
  /** Runs the full non-destructive transcription pipeline. */
  transcribe: () => Promise<void>;
  /** Re-renders the current page from the already loaded score. */
  refresh: () => Promise<void>;
  /** Applies the layout settings to the loaded score and re-renders. */
  applyLayout: () => Promise<void>;
  /** Navigates to a page (clamped) and re-renders. */
  gotoPage: (target: number) => void;
  /** Sets a field-wise error message (or clears it with an empty string). */
  setError: (message: string) => void;
  /** Print action: render all pages with the paginated layout and print. */
  onPrint: () => void;
  /** Export action: render all pages to a PDF and download it. */
  onExportPdf: () => void;
  /** Export action: download the last transcription's MusicXML. */
  onExportMusicXml: () => void;
  /** Export action: download the current part's MusicXML. */
  onExportPartMusicXml: () => void;
}

interface ScorePageRenderer {
  load(musicXml: string, layout?: ReturnType<typeof scorePrintLayoutOptions>): Promise<number>;
  renderPage(page?: number): Promise<string>;
}

interface ScoreArtifact {
  identity: OperationIdentity;
  xml: string;
  score: NotatedScore;
  svg: string;
  partTrackIds: number[];
  projectName: string;
  fullScore: boolean;
}

function sameOperationIdentity(a: OperationIdentity, b: OperationIdentity): boolean {
  return a.projectId === b.projectId && a.targetId === b.targetId && a.revision === b.revision;
}

export const MAX_SCORE_EXPORT_PAGES = 500;

function throwIfSnapshotInvalid(signal?: AbortSignal, isCurrent?: () => boolean): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Score export cancelled.', 'AbortError');
  }
  if (isCurrent && !isCurrent()) {
    throw new DOMException('Score export superseded.', 'AbortError');
  }
}

/** Renders a frozen MusicXML/layout snapshot without mutating the screen toolkit. */
export async function renderScorePagesSnapshot(
  client: ScorePageRenderer,
  musicXml: string,
  layout: ReturnType<typeof scorePrintLayoutOptions>,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<string[]> {
  const pages: string[] = [];
  await consumeScorePagesSnapshot(
    client,
    musicXml,
    layout,
    async (svg) => {
      pages.push(svg);
    },
    signal,
    isCurrent,
  );
  return pages;
}

/** Renders and hands off one snapshot page at a time without retaining prior SVG strings. */
export async function consumeScorePagesSnapshot(
  client: ScorePageRenderer,
  musicXml: string,
  layout: ReturnType<typeof scorePrintLayoutOptions>,
  consume: (svg: string, page: number, pageCount: number) => Promise<void> | void,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
  memory: {
    budgetBytes?: number;
    onSample?: (sample: PayloadMemorySample) => void;
  } = {},
): Promise<number> {
  const xmlSnapshot = String(musicXml);
  const layoutSnapshot = structuredClone(layout);
  const count = await client.load(xmlSnapshot, layoutSnapshot);
  throwIfSnapshotInvalid(signal, isCurrent);
  if (!Number.isInteger(count) || count < 0 || count > MAX_SCORE_EXPORT_PAGES) {
    throw new RangeError(
      `Score export page count ${count} exceeds limit ${MAX_SCORE_EXPORT_PAGES}`,
    );
  }
  const meter = new PayloadMemoryMeter({
    operation: 'score-export',
    label: 'Score SVG export',
    budgetBytes: memory.budgetBytes ?? DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES,
    onSample: memory.onSample,
  });
  for (let page = 1; page <= count; page++) {
    const svg = await client.renderPage(page);
    throwIfSnapshotInvalid(signal, isCurrent);
    const releaseSvg = meter.retain(utf8ByteLength(svg), `page ${page}/${count}`);
    try {
      await consume(svg, page, count);
      throwIfSnapshotInvalid(signal, isCurrent);
    } finally {
      releaseSvg();
    }
  }
  return count;
}

/** Snapshot inputs shared by screen transcription and File-menu MusicXML export. */
export interface ProjectScoreBuildOptions {
  divisionPpq: number;
  timeSig: { beats: number; beatUnit: number };
  measureLenPpq: number;
  clipLengthPpq: number;
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
  pickupLengthPpq?: number;
  keyFifths: number;
  chordsEnabled: boolean;
  fullScoreEnabled: boolean;
  estimateFingering?: boolean;
  grandStaffSplitPitch?: number;
  layoutSettings: Pick<ScoreLayoutSettings, 'barsPerSystem' | 'barsPerPage'>;
}

/**
 * Builds the canonical project score used by every MusicXML surface. This is
 * intentionally independent of Verovio, so File-menu export and the visible
 * score share quantization, annotations, marks and chord spelling exactly.
 */
export async function buildProjectScore(
  store: ProjectStore,
  options: ProjectScoreBuildOptions,
): Promise<NotatedScore> {
  const fullScore = options.fullScoreEnabled;
  const displayTransposeSemitones = store.displayTransposeSemitones;
  const displayKeyFifths = transposeKeyFifths(options.keyFifths, displayTransposeSemitones);
  const scoreProjection = fullScore
    ? buildFullScoreProjection(store, store.clipStartPpq, options.clipLengthPpq)
    : buildScoreProjection(
        store.activeClip && clipKind(store.activeClip) === 'midi' ? [store.activeClip] : [],
        store.scoreAnnotations,
      );
  const midiTracks = store.tracks.filter((track) => track.kind === 'midi');
  const activeTrackIndex = midiTracks.findIndex((track) => track.id === store.activeClip?.trackId);
  const activePartName =
    midiTracks[activeTrackIndex]?.name ||
    defaultName('track', { number: Math.max(activeTrackIndex, 0) + 1 });
  const score = fullScore
    ? buildFullScore(
        store,
        {
          divisionPpq: options.divisionPpq,
          timeSig: { ...options.timeSig },
          keyFifths: displayKeyFifths,
          clipStartPpq: store.clipStartPpq,
          clipLengthPpq: options.clipLengthPpq,
          timeSignatures: options.timeSignatures,
          pickupLengthPpq: options.pickupLengthPpq,
          displayTransposeSemitones,
          grandStaffSplitPitch: options.grandStaffSplitPitch,
          estimateFingering: options.estimateFingering,
        },
        scoreProjection,
      )
    : buildScorePart(scoreProjection.notes, {
        divisionPpq: options.divisionPpq,
        timeSig: options.timeSig,
        keyFifths: displayKeyFifths,
        clipStartPpq: store.clipStartPpq,
        clipLengthPpq: options.clipLengthPpq,
        timeSignatures: options.timeSignatures,
        pickupLengthPpq: options.pickupLengthPpq,
        partName: activePartName,
        clef: 'grand',
        grandStaffSplitPitch: options.grandStaffSplitPitch,
        estimateFingering: options.estimateFingering,
        displayTransposeSemitones,
        track: store.tracks.find((entry) => entry.id === store.activeClip?.trackId) ?? null,
      });
  if (!fullScore && Object.keys(scoreProjection.annotations).length > 0) {
    score.noteAnnotations = scoreProjection.annotations;
  }
  if (displayTransposeSemitones !== 0) score.transposeSemitones = displayTransposeSemitones;
  const title = store.projectName.trim();
  if (title) score.metadata = { title };
  applySectionMarks(
    score,
    store.sections,
    store.clipStartPpq,
    options.clipLengthPpq,
    options.measureLenPpq,
  );
  applyLayoutBreaks(
    score,
    store.sections,
    store.clipStartPpq,
    options.measureLenPpq,
    options.layoutSettings,
  );
  applyMarkerTexts(
    score,
    store.markers,
    store.clipStartPpq,
    options.clipLengthPpq,
    options.measureLenPpq,
  );
  applyLyricMarks(score, store.markers, store.clipStartPpq, options.clipLengthPpq);
  applyKeySignatureMarks(
    score,
    store.markers,
    store.clipStartPpq,
    options.clipLengthPpq,
    options.measureLenPpq,
    displayTransposeSemitones,
  );
  applyTempoMarks(
    score,
    store.tempoSegments,
    store.tempoBpm,
    store.clipStartPpq,
    options.clipLengthPpq,
    options.measureLenPpq,
  );
  applyMultiMeasureRests(score);
  if (options.chordsEnabled) {
    try {
      const estimated: EstimatedChordSymbol[] = estimateChordSymbols(
        chordEstimateNotes(store, scoreProjection),
        {
          clipStartPpq: store.clipStartPpq,
          clipLengthPpq: options.clipLengthPpq,
          measureLengthPpq: options.measureLenPpq,
          measures: score.parts[0]?.measures,
          keyFifths: displayKeyFifths,
        },
      );
      const symbols = await canonicalizeChordSymbols(estimated);
      if (symbols.length > 0) {
        score.chordSymbols = transposeChordSymbols(
          symbols,
          displayTransposeSemitones,
          displayKeyFifths,
        );
      }
    } catch {
      // Chord symbols are supplementary display data; a wasm failure must not
      // prevent export of the score itself.
    }
  }
  return score;
}

/** Wires the non-destructive notation pipeline for the score panel. */
export function useScoreNotation(options: ScoreNotationOptions): ScoreNotation {
  const { t } = useI18n();
  const { store, client } = options;

  const loading = ref(false);
  const exporting = ref(false);
  const error = ref('');
  const svg = ref('');
  const page = ref(1);
  const pageCount = ref(0);

  /** Last atomically published score/XML/SVG and the source revision that produced it. */
  let currentArtifact: ScoreArtifact | null = null;
  // Bumped on every artifact change so computed readers of the current score re-evaluate.
  const artifactRevision = shallowRef(0);
  const setCurrentArtifact = (next: ScoreArtifact | null): void => {
    currentArtifact = next;
    artifactRevision.value += 1;
  };
  /** Timemap of the last successful load (paired with the same load's SVG ids). */
  let timemap: ReadonlyArray<VerovioTimemapEntry> = [];
  const screenOperations = new OperationGeneration();
  const exportOperations = new OperationGeneration();
  let activeExportClient: VerovioClient | null = null;
  let activeExportSignal: AbortSignal | undefined;

  function transcriptionIdentity(): OperationIdentity {
    return {
      projectId: store.documentGeneration,
      targetId: store.clipId,
      revision: fnv1a32Hex(
        canonicalJson({
          initialized: store.initialized,
          activeTrackId: store.activeTrackId,
          clips: store.clips,
          tracks: store.tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            name: track.name,
            musicXmlPartId: track.musicXmlPartId,
            percussion: track.percussion,
            instrument: track.instrument,
            generatedPart: track.generated?.part,
          })),
          annotations: store.scoreAnnotations,
          sections: store.sections,
          markers: store.markers,
          tempoSegments: store.tempoSegments,
          tempoBpm: store.tempoBpm,
          timeSignatures: options.getTimeSignatures?.(),
          pickupLengthPpq: options.getPickupLengthPpq?.(),
          clipStartPpq: store.clipStartPpq,
          clipLengthPpq: store.clipLengthPpq,
          screenClipLengthPpq: options.getScreenClipLengthPpq(),
          divisionPpq: options.getDivisionPpq(),
          timeSig: options.getTimeSig(),
          measureLenPpq: options.getMeasureLenPpq(),
          keyFifths: options.getKeyFifths(),
          chordsEnabled: options.getChordsEnabled(),
          fullScoreEnabled: options.getFullScoreEnabled?.(),
          estimateFingering: options.getEstimateFingering?.(),
          grandStaffSplitPitch: options.getGrandStaffSplitPitch?.(),
          displayTransposeSemitones: store.displayTransposeSemitones,
          projectName: store.projectName,
          layoutBreaks: {
            barsPerSystem: options.getLayoutSettings().barsPerSystem,
            barsPerPage: options.getLayoutSettings().barsPerPage,
          },
        }),
      ),
    };
  }

  function screenIdentity(): OperationIdentity {
    const transcription = transcriptionIdentity();
    return {
      ...transcription,
      revision: fnv1a32Hex(
        canonicalJson({
          transcriptionRevision: transcription.revision,
          layout: options.getLayoutSettings(),
        }),
      ),
    };
  }

  // Hashing the identity serializes every clip, so share one cached result
  // between all readers instead of recomputing it per call.
  const currentStateArtifact = computed<ScoreArtifact | null>(() => {
    void artifactRevision.value;
    const artifact = currentArtifact;
    return artifact && sameOperationIdentity(artifact.identity, transcriptionIdentity())
      ? artifact
      : null;
  });

  function artifactForCurrentState(): ScoreArtifact | null {
    return currentStateArtifact.value;
  }

  /**
   * Omits tempo directions from the screen-only engraving. The screen client
   * does not play this XML; playhead sync compares timemap qstamp with PPQ.
   */
  function serializeScreenMusicXml(score: NotatedScore): string {
    const screenScore = { ...score };
    delete screenScore.measureTempos;
    delete screenScore.measureTempoMarks;
    delete screenScore.measureTempoTexts;
    delete screenScore.transposeSemitones;
    return serializeMusicXml(screenScore);
  }

  function clearArtifacts(): void {
    setCurrentArtifact(null);
    svg.value = '';
    page.value = 1;
    pageCount.value = 0;
    timemap = [];
    options.resetPlayheadScan();
  }

  function screenOperationIsCurrent(token: OperationToken, verovio: VerovioClient): boolean {
    return client.value === verovio && screenOperations.isCurrent(token, screenIdentity());
  }

  function exportIdentity(musicXml: string, settings: ScoreLayoutSettings): OperationIdentity {
    const screen = screenIdentity();
    return {
      ...screen,
      revision: fnv1a32Hex(canonicalJson({ screenRevision: screen.revision, musicXml, settings })),
    };
  }

  /**
   * On-screen layout: one continuous system with NO line/system breaks, cropped
   * to the content on both axes. The engraved strip then scrolls horizontally
   * instead of wrapping to multiple lines. Print/PDF use the paginated
   * `scorePrintLayoutOptions()` instead.
   */
  function screenLayoutOptions() {
    return scoreScreenLayoutOptions(options.getLayoutSettings());
  }

  /**
   * Re-runs the full non-destructive pipeline:
   * notes -> quantizeToScore -> (optional chord symbols) -> MusicXML -> Verovio.
   */
  async function transcribe(): Promise<void> {
    // A previously crashed worker leaves the client permanently failed; replace it
    // so the user can recover by re-transcribing instead of reloading the app.
    if (client.value?.failed) {
      client.value.dispose();
      client.value = options.createClient?.() ?? new VerovioClient();
    }
    const verovio = client.value;
    const fullScoreRequested = options.getFullScoreEnabled?.() === true;
    if (
      !verovio ||
      !store.initialized ||
      store.clipLengthPpq <= 0 ||
      !store.activeClip ||
      (!fullScoreRequested && clipKind(store.activeClip) !== 'midi')
    ) {
      screenOperations.invalidate();
      exportOperations.invalidate();
      activeExportClient?.dispose();
      activeExportClient = null;
      loading.value = false;
      clearArtifacts();
      return;
    }
    if (!artifactForCurrentState()) clearArtifacts();
    const token = screenOperations.begin(screenIdentity());
    loading.value = true;
    error.value = '';
    try {
      const fullScore = fullScoreRequested;
      const score = await buildProjectScore(store, {
        divisionPpq: options.getDivisionPpq(),
        timeSig: options.getTimeSig(),
        measureLenPpq: options.getMeasureLenPpq(),
        clipLengthPpq: options.getScreenClipLengthPpq(),
        timeSignatures: options.getTimeSignatures?.(),
        pickupLengthPpq: options.getPickupLengthPpq?.(),
        keyFifths: options.getKeyFifths(),
        chordsEnabled: options.getChordsEnabled(),
        fullScoreEnabled: fullScore,
        estimateFingering: options.getEstimateFingering?.(),
        grandStaffSplitPitch: options.getGrandStaffSplitPitch?.(),
        layoutSettings: options.getLayoutSettings(),
      });
      const partTrackIds = fullScore
        ? fullScorePartTrackIds(store, store.clipStartPpq, options.getScreenClipLengthPpq())
        : [store.activeClip.trackId];
      if (!screenOperationIsCurrent(token, verovio)) return;
      const xml = serializeMusicXml(score);
      const screenXml = serializeScreenMusicXml(score);
      const count = await verovio.load(screenXml, screenLayoutOptions());
      if (!screenOperationIsCurrent(token, verovio)) return;
      const nextPage = clamp(page.value, 1, Math.max(count, 1));
      const [pageSvg, entries] = await Promise.all([
        verovio.renderPage(nextPage),
        verovio.getTimemap(),
      ]);
      if (!screenOperationIsCurrent(token, verovio)) return;
      setCurrentArtifact({
        identity: transcriptionIdentity(),
        xml,
        score,
        svg: pageSvg,
        partTrackIds,
        projectName: store.projectName,
        fullScore,
      });
      pageCount.value = count;
      page.value = nextPage;
      svg.value = pageSvg;
      timemap = entries;
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = errorMessage(err);
    } finally {
      if (screenOperationIsCurrent(token, verovio)) loading.value = false;
    }
  }

  /** Re-renders the current page from the already loaded score. */
  async function refresh(): Promise<void> {
    const verovio = client.value;
    if (!verovio || pageCount.value === 0) return;
    const artifact = artifactForCurrentState();
    if (!artifact) {
      clearArtifacts();
      void transcribe();
      return;
    }
    const token = screenOperations.begin(screenIdentity());
    verovio.cancelPending(new DOMException('Score refresh superseded.', 'AbortError'));
    loading.value = true;
    error.value = '';
    try {
      const pageSvg = await verovio.renderPage(page.value);
      if (!screenOperationIsCurrent(token, verovio)) return;
      svg.value = pageSvg;
      setCurrentArtifact({ ...artifact, svg: pageSvg });
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = errorMessage(err);
    } finally {
      if (screenOperationIsCurrent(token, verovio)) loading.value = false;
    }
  }

  /** Applies the layout settings to the loaded score and re-renders. */
  async function applyLayout(): Promise<void> {
    const verovio = client.value;
    const artifact = artifactForCurrentState();
    if (!verovio || pageCount.value === 0 || !artifact) {
      if (!artifact) clearArtifacts();
      void transcribe();
      return;
    }
    const token = screenOperations.begin(screenIdentity());
    verovio.cancelPending(new DOMException('Score layout superseded.', 'AbortError'));
    loading.value = true;
    error.value = '';
    try {
      const count = await verovio.setLayout(screenLayoutOptions());
      if (!screenOperationIsCurrent(token, verovio)) return;
      const nextPage = clamp(page.value, 1, Math.max(count, 1));
      // Note ids survive redoLayout, so the existing timemap stays valid.
      const pageSvg = await verovio.renderPage(nextPage);
      if (!screenOperationIsCurrent(token, verovio)) return;
      pageCount.value = count;
      page.value = nextPage;
      svg.value = pageSvg;
      setCurrentArtifact({ ...artifact, svg: pageSvg });
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = errorMessage(err);
    } finally {
      if (screenOperationIsCurrent(token, verovio)) loading.value = false;
    }
  }

  function gotoPage(target: number): void {
    if (pageCount.value === 0) return;
    const next = clamp(target, 1, pageCount.value);
    if (next === page.value) return;
    page.value = next;
    void refresh();
  }

  /** Renders every page in an isolated client from immutable XML/layout snapshots. */
  async function consumeAllPages(
    settings: ScoreLayoutSettings,
    consume: (svg: string, page: number, pageCount: number) => Promise<void> | void,
  ): Promise<number> {
    const artifact = artifactForCurrentState();
    if (!artifact) return 0;
    const xmlSnapshot = String(artifact.xml);
    const settingsSnapshot = structuredClone(settings);
    const identity = exportIdentity(xmlSnapshot, settingsSnapshot);
    const token = exportOperations.begin(identity);
    activeExportSignal = token.signal;
    const verovio = options.createExportClient?.() ?? new VerovioClient();
    activeExportClient = verovio;
    try {
      return await consumeScorePagesSnapshot(
        verovio,
        xmlSnapshot,
        scorePrintLayoutOptions(settingsSnapshot),
        consume,
        token.signal,
        () =>
          sameOperationIdentity(artifact.identity, transcriptionIdentity()) &&
          exportOperations.isCurrent(token, exportIdentity(xmlSnapshot, settingsSnapshot)),
      );
    } finally {
      if (activeExportClient === verovio) activeExportClient = null;
      verovio.dispose();
    }
  }

  /** Runs an export action with the busy flag and error reporting. */
  async function runExport(action: () => Promise<void>): Promise<void> {
    if (exporting.value) return;
    exporting.value = true;
    error.value = '';
    try {
      await action();
    } catch (err) {
      if (isAbortError(err)) return;
      error.value = errorMessage(err);
    } finally {
      exportOperations.invalidate();
      activeExportSignal = undefined;
      exporting.value = false;
    }
  }

  function onPrint(): void {
    if (loading.value || !artifactForCurrentState()) return;
    void runExport(async () => {
      const settings = structuredClone(options.getLayoutSettings());
      const output: { writer: ReturnType<typeof createPrintPageWriter> | null } = { writer: null };
      await consumeAllPages(settings, (svg, page, pageCount) => {
        output.writer ??= createPrintPageWriter(pageCount, scorePageDimsMm(settings));
        output.writer.addPage(svg, page);
      });
      output.writer?.print();
    });
  }

  function onExportPdf(): void {
    if (loading.value) return;
    const artifact = artifactForCurrentState();
    if (!artifact) return;
    void runExport(async () => {
      const settings = structuredClone(options.getLayoutSettings());
      const title = store.projectName.trim() || t.value.shell.score.engravedScore;
      const subject = t.value.shell.score.engravedScore;
      const pageLabel = t.value.shell.score.pdfPageLabel;
      const layout = scorePageDimsMm(settings);
      let text: PdfTextPlan;
      try {
        text = await planPdfText([musicXmlText(artifact.xml), title, subject, pageLabel]);
      } catch (err) {
        if (!(err instanceof PdfTextFontUnavailableError)) throw err;
        error.value = t.value.shell.score.pdfFontUnavailable;
        return;
      }
      if (!(await confirmPdfTextLoss(text.undrawable))) return;
      const pdf: { writer: Awaited<ReturnType<typeof createPdfPageWriter>> | null } = {
        writer: null,
      };
      await consumeAllPages(settings, async (svg, page, pageCount) => {
        pdf.writer ??= await createPdfPageWriter(pageCount, layout, {
          title,
          author: 'sonare studio',
          subject,
          headerTitle: title,
          pageLabel,
          text,
          signal: activeExportSignal,
        });
        await pdf.writer.addPage(svg, page);
      });
      if (!pdf.writer) return;
      const blob = pdf.writer.close();
      if (!(await confirmPdfTextLoss(pdf.writer.undrawable()))) return;
      downloadBlob(blob, projectFilename(store.projectName, '.pdf', 'score'));
    });
  }

  /** Asks before a PDF leaves out characters its font cannot draw. */
  function confirmPdfTextLoss(characters: readonly string[]): Promise<boolean> {
    const report: LossReport<'undrawableCharacters'> = {
      entries:
        characters.length === 0
          ? []
          : [
              {
                kind: 'undrawableCharacters',
                count: characters.length,
                details: characters.map(characterLabel),
              },
            ],
    };
    return confirmLossReport(report, t.value.shell.project.pdfExportLoss);
  }

  /** Asks before a MusicXML file drops content the engraved score cannot carry. */
  function confirmMusicXmlLoss(fullScore: boolean, trackId?: number): Promise<boolean> {
    const loss = inspectMusicXmlExportLoss(
      musicXmlScoredDocument(store, fullScore, trackId),
      options.getDivisionPpq(),
    );
    return confirmLossReport(loss, t.value.shell.project.musicXmlExportLoss);
  }

  function onExportMusicXml(): void {
    if (loading.value) return;
    const artifact = artifactForCurrentState();
    if (!artifact) return;
    void runExport(async () => {
      if (!(await confirmMusicXmlLoss(artifact.fullScore))) return;
      if (artifactForCurrentState() !== artifact) return;
      exportMusicXml(artifact.xml, projectFilename(artifact.projectName, '.musicxml', 'score'));
    });
  }

  function onExportPartMusicXml(): void {
    if (loading.value) return;
    const artifact = artifactForCurrentState();
    if (!artifact || artifact.score.parts.length === 0) return;
    const partIndices = artifact.partTrackIds.flatMap((trackId, index) =>
      trackId === store.activeTrackId ? [index] : [],
    );
    if (partIndices.length === 0) return;
    const part = artifact.score.parts[partIndices[0]];
    if (!part) return;
    void runExport(async () => {
      if (!(await confirmMusicXmlLoss(artifact.fullScore, store.activeTrackId))) return;
      if (artifactForCurrentState() !== artifact) return;
      const partScore = extractPartsScore(artifact.score, partIndices);
      const xml = serializeMusicXml(partScore);
      const projectName = artifact.projectName.trim() || 'score';
      exportMusicXml(
        xml,
        projectFilename(`${projectName} - ${part.name}`, '.part.musicxml', 'score-part'),
      );
    });
  }

  return {
    loading,
    exporting,
    error,
    svg,
    page,
    pageCount,
    getTimemap: () => timemap,
    getCurrentXml: () => artifactForCurrentState()?.xml ?? '',
    getCurrentPartName: () => {
      const artifact = artifactForCurrentState();
      if (!artifact) return '';
      const index = artifact.partTrackIds.indexOf(store.activeTrackId);
      return index >= 0 ? (artifact.score.parts[index]?.name ?? '') : '';
    },
    bumpGeneration: (clear = false) => {
      screenOperations.invalidate();
      exportOperations.invalidate();
      client.value?.cancelPending();
      activeExportClient?.dispose();
      activeExportClient = null;
      loading.value = false;
      if (clear) clearArtifacts();
    },
    transcribe,
    refresh,
    applyLayout,
    gotoPage,
    setError: (message: string) => {
      error.value = message;
    },
    onPrint,
    onExportPdf,
    onExportMusicXml,
    onExportPartMusicXml,
  };
}

/** Every text node of a MusicXML document, the text an engraving of it can carry. */
function musicXmlText(xml: string): string {
  return new DOMParser().parseFromString(xml, 'application/xml').documentElement.textContent ?? '';
}

/**
 * How a character the PDF cannot draw is named to the user: itself, or its code
 * point when it is a private-use character no text font shows (a SMuFL glyph).
 */
export function characterLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const privateUse = (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000;
  return privateUse ? `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}` : character;
}

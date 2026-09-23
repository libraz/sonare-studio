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

import { type Ref, ref, type ShallowRef } from 'vue';
import { keySignatureFromMarker } from '@/compose/key-name';
import { harmonicTracksOnly } from '@/compose/tracks';
import { DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import { projectFilename } from '@/lib/filename';
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
import {
  DEFAULT_DIVISIONS,
  measureHasMultiRestStructure,
  type NotatedChordSymbol,
  type NotatedLyric,
  type NotatedLyricSyllabic,
  type NotatedMeasure,
  type NotatedScore,
  type NotatedTempoMark,
  type NotatedTempoText,
} from '@/notation/model';
import { extractPartsScore, serializeMusicXml } from '@/notation/musicxml';
import { chordPitchClassName } from '@/notation/pitch-spelling';
import { createPdfPageWriter, createPrintPageWriter, downloadBlob } from '@/notation/print';
import type { ScoreInputNote } from '@/notation/quantize';
import { quantizeToScore } from '@/notation/quantize';
import { VerovioClient, type VerovioTimemapEntry } from '@/notation/verovio';
import type { ScoreAnnotations, ScoreNoteAnnotation } from '@/project/annotations';
import { canonicalJson, fnv1a32Hex } from '@/project/hash';
import {
  type MidiSourceIdentity,
  midiSourceIdentityKey,
  projectMidiNoteOccurrences,
} from '@/project/midi-projection';
import type { useProjectStore } from '@/project/store';
import { normalizeTempoMap, tempoAtPpq } from '@/project/tempo-map';
import {
  clipKind,
  type EditorClip,
  type EditorMarker,
  type EditorSection,
  type TempoSegment,
  type TimeSignatureSegment,
} from '@/project/types';
import {
  type ScoreLayoutSettings,
  scorePageDimsMm,
  scorePrintLayoutOptions,
  scoreScreenLayoutOptions,
} from '@/ui/score/layout';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Tolerance for matching section starts to engraved measure boundaries. */
const PPQ_EPSILON = 1e-6;
/** Zero-based General MIDI percussion channel. */
const GM_PERCUSSION_CHANNEL = 9;

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
        partName: 'Piano',
        clef: 'grand',
        grandStaffSplitPitch: options.grandStaffSplitPitch,
        estimateFingering: options.estimateFingering,
        displayTransposeSemitones,
      });
  if (!fullScore && Object.keys(scoreProjection.annotations).length > 0) {
    score.noteAnnotations = scoreProjection.annotations;
  }
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
  const { store, client } = options;

  const loading = ref(false);
  const exporting = ref(false);
  const error = ref('');
  const svg = ref('');
  const page = ref(1);
  const pageCount = ref(0);

  /** Last atomically published score/XML/SVG and the source revision that produced it. */
  let currentArtifact: ScoreArtifact | null = null;
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

  function artifactForCurrentState(): ScoreArtifact | null {
    const artifact = currentArtifact;
    return artifact && sameOperationIdentity(artifact.identity, transcriptionIdentity())
      ? artifact
      : null;
  }

  function clearArtifacts(): void {
    currentArtifact = null;
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
      const count = await verovio.load(xml, screenLayoutOptions());
      if (!screenOperationIsCurrent(token, verovio)) return;
      const nextPage = Math.min(Math.max(page.value, 1), Math.max(count, 1));
      const [pageSvg, entries] = await Promise.all([
        verovio.renderPage(nextPage),
        verovio.getTimemap(),
      ]);
      if (!screenOperationIsCurrent(token, verovio)) return;
      currentArtifact = {
        identity: transcriptionIdentity(),
        xml,
        score,
        svg: pageSvg,
        partTrackIds,
        projectName: store.projectName,
      };
      pageCount.value = count;
      page.value = nextPage;
      svg.value = pageSvg;
      timemap = entries;
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = err instanceof Error ? err.message : String(err);
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
      currentArtifact = { ...artifact, svg: pageSvg };
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = err instanceof Error ? err.message : String(err);
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
      const nextPage = Math.min(Math.max(page.value, 1), Math.max(count, 1));
      // Note ids survive redoLayout, so the existing timemap stays valid.
      const pageSvg = await verovio.renderPage(nextPage);
      if (!screenOperationIsCurrent(token, verovio)) return;
      pageCount.value = count;
      page.value = nextPage;
      svg.value = pageSvg;
      currentArtifact = { ...artifact, svg: pageSvg };
      options.resetPlayheadScan();
    } catch (err) {
      if (!screenOperationIsCurrent(token, verovio)) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (screenOperationIsCurrent(token, verovio)) loading.value = false;
    }
  }

  function gotoPage(target: number): void {
    if (pageCount.value === 0) return;
    const next = Math.min(Math.max(target, 1), pageCount.value);
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
          artifactForCurrentState() === artifact &&
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
      if (err instanceof DOMException && err.name === 'AbortError') return;
      error.value = err instanceof Error ? err.message : String(err);
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
    if (loading.value || !artifactForCurrentState()) return;
    void runExport(async () => {
      const settings = structuredClone(options.getLayoutSettings());
      const title = store.projectName.trim() || 'score';
      const layout = scorePageDimsMm(settings);
      const pdf: { writer: Awaited<ReturnType<typeof createPdfPageWriter>> | null } = {
        writer: null,
      };
      await consumeAllPages(settings, async (svg, page, pageCount) => {
        pdf.writer ??= await createPdfPageWriter(pageCount, layout, {
          title,
          author: 'sonare studio',
          subject: 'Engraved score',
          headerTitle: title,
          pageNumbers: true,
          signal: activeExportSignal,
        });
        await pdf.writer.addPage(svg, page);
      });
      if (!pdf.writer) return;
      const blob = pdf.writer.close();
      downloadBlob(blob, projectFilename(store.projectName, '.pdf', 'score'));
    });
  }

  function onExportMusicXml(): void {
    if (loading.value) return;
    const artifact = artifactForCurrentState();
    if (!artifact) return;
    void runExport(async () => {
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

interface FullScoreBuildOptions {
  divisionPpq: number;
  timeSig: { beats: number; beatUnit: number };
  keyFifths: number;
  clipStartPpq: number;
  clipLengthPpq: number;
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
  pickupLengthPpq?: number;
  displayTransposeSemitones: number;
  grandStaffSplitPitch?: number;
  estimateFingering?: boolean;
}

/** Inputs shared by active-clip and full-arrangement part transcription. */
export interface ScorePartBuildOptions extends FullScoreBuildOptions {
  partId?: string;
  partName: string;
  clef?: 'treble' | 'bass' | 'grand';
}

/**
 * Transcribes one project part. Keeping this as the single quantization path
 * prevents full-score parts from drifting from the active-clip score.
 */
export function buildScorePart(
  notes: ReadonlyArray<ScoreInputNote>,
  options: ScorePartBuildOptions,
): NotatedScore {
  return quantizeToScore(notes, {
    divisionPpq: options.divisionPpq,
    timeSig: { ...options.timeSig },
    keyFifths: options.keyFifths,
    clipStartPpq: options.clipStartPpq,
    clipLengthPpq: options.clipLengthPpq,
    timeSignatures: options.timeSignatures,
    pickupLengthPpq: options.pickupLengthPpq,
    partId: options.partId,
    partName: options.partName,
    clef: options.clef,
    displayTransposeSemitones: options.displayTransposeSemitones,
    grandStaffSplitPitch: options.grandStaffSplitPitch,
    estimateFingering: options.estimateFingering,
  });
}

export interface ScoreProjection {
  annotations: Record<number, ScoreNoteAnnotation>;
  notes: ScoreInputNote[];
  notesByTrack: Map<number, ScoreInputNote[]>;
}

function remapAnnotationTargets(
  annotation: ScoreNoteAnnotation,
  identity: MidiSourceIdentity,
  displayIdBySource: ReadonlyMap<string, number>,
): ScoreNoteAnnotation {
  const targetId = (noteId: number | undefined): number | undefined =>
    noteId === undefined
      ? undefined
      : displayIdBySource.get(midiSourceIdentityKey({ ...identity, noteId }));
  const slurToNoteId = targetId(annotation.slurToNoteId);
  const hairpinToNoteId = targetId(annotation.hairpinToNoteId);
  const lineSpanToNoteId = targetId(annotation.lineSpanToNoteId);
  const lineSpans = annotation.lineSpans
    ?.map((span) => {
      const mapped = targetId(span.lineSpanToNoteId);
      return mapped === undefined ? null : { ...span, lineSpanToNoteId: mapped };
    })
    .filter((span): span is NonNullable<typeof span> => span !== null);
  return {
    ...annotation,
    slurToNoteId,
    hairpinToNoteId,
    lineSpanToNoteId,
    ...(lineSpans ? { lineSpans } : {}),
  };
}

/**
 * The projected notes chord estimation reads: harmonic tracks only, with the
 * percussion channel dropped per track as the arrangement-wide estimate does.
 */
export function chordEstimateNotes(
  store: Pick<ProjectStore, 'tracks'>,
  projection: ScoreProjection,
): ScoreInputNote[] {
  const items = store.tracks.flatMap((track) => {
    const notes = projection.notesByTrack.get(track.id);
    return notes === undefined ? [] : [{ track, notes }];
  });
  return harmonicTracksOnly(items).harmonic.flatMap((item) => item.notes);
}

/** Builds one identity-preserving projected input shared by active/full score. */
export function buildScoreProjection(
  clips: ReadonlyArray<EditorClip>,
  sourceAnnotations: Readonly<ScoreAnnotations> = {},
): ScoreProjection {
  const notes: ScoreInputNote[] = [];
  const notesByTrack = new Map<number, ScoreInputNote[]>();
  const displayIdBySource = new Map<string, number>();
  const sourceByDisplayId = new Map<number, MidiSourceIdentity>();
  for (const clip of clips) {
    if (clipKind(clip) !== 'midi') continue;
    for (const projected of projectMidiNoteOccurrences(clip)) {
      const id = notes.length + 1;
      const { sourceIdentity, ...projectedNote } = projected;
      const scoreNote: ScoreInputNote = {
        ...projectedNote,
        id,
        scoreSourceIdentity: { ...sourceIdentity },
      };
      notes.push(scoreNote);
      const trackNotes = notesByTrack.get(clip.trackId) ?? [];
      trackNotes.push(scoreNote);
      notesByTrack.set(clip.trackId, trackNotes);
      displayIdBySource.set(midiSourceIdentityKey(sourceIdentity), id);
      sourceByDisplayId.set(id, sourceIdentity);
    }
  }
  const annotations: Record<number, ScoreNoteAnnotation> = {};
  for (const [displayId, identity] of sourceByDisplayId) {
    const annotation = sourceAnnotations[identity.clipId]?.[identity.noteId];
    if (!annotation) continue;
    annotations[displayId] = remapAnnotationTargets(annotation, identity, displayIdBySource);
  }
  return { annotations, notes, notesByTrack };
}

/** Builds the same audible, windowed MIDI input used by every Full Score part. */
export function buildFullScoreProjection(
  store: Pick<ProjectStore, 'clips' | 'scoreAnnotations'>,
  clipStartPpq: number,
  clipLengthPpq: number,
): ScoreProjection {
  const windowEnd = clipStartPpq + clipLengthPpq;
  const relevantClips = store.clips.filter(
    (clip) =>
      clipKind(clip) === 'midi' &&
      clip.startPpq < windowEnd &&
      clip.startPpq + clip.lengthPpq > clipStartPpq,
  );
  return buildScoreProjection(relevantClips, store.scoreAnnotations ?? {});
}

/** Maps every emitted Full Score part back to its source MIDI track. */
export function fullScorePartTrackIds(
  store: Pick<ProjectStore, 'tracks' | 'clips' | 'scoreAnnotations'>,
  clipStartPpq: number,
  clipLengthPpq: number,
): number[] {
  const projection = buildFullScoreProjection(store, clipStartPpq, clipLengthPpq);
  return store.tracks
    .filter((track) => track.kind === 'midi')
    .flatMap((track) => {
      const notes = projection.notesByTrack.get(track.id) ?? [];
      const hasPitched = notes.some((note) => note.channel !== GM_PERCUSSION_CHANNEL);
      const hasPercussion = notes.some((note) => note.channel === GM_PERCUSSION_CHANNEL);
      return hasPitched && hasPercussion ? [track.id, track.id] : [track.id];
    });
}

/** Allocates a stable MusicXML part id without colliding with earlier parts. */
function allocateMusicXmlPartId(preferred: string, used: Set<string>): string {
  const base = preferred.trim() || 'P1';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function buildFullScore(
  store: ProjectStore,
  options: FullScoreBuildOptions,
  projection = buildFullScoreProjection(store, options.clipStartPpq, options.clipLengthPpq),
): NotatedScore {
  const usedPartIds = new Set<string>();
  const parts = store.tracks
    .filter((track) => track.kind === 'midi')
    .flatMap((track, index) => {
      const notes = projection.notesByTrack.get(track.id) ?? [];
      const requestedPartId = track.musicXmlPartId?.trim() || `P${index + 1}`;
      const partId = allocateMusicXmlPartId(requestedPartId, usedPartIds);
      const score = buildScorePart(notes, {
        divisionPpq: options.divisionPpq,
        timeSig: options.timeSig,
        keyFifths: options.keyFifths,
        clipStartPpq: options.clipStartPpq,
        clipLengthPpq: options.clipLengthPpq,
        timeSignatures: options.timeSignatures,
        pickupLengthPpq: options.pickupLengthPpq,
        partId,
        partName: track.name || `Track ${index + 1}`,
        displayTransposeSemitones: options.displayTransposeSemitones,
        grandStaffSplitPitch: options.grandStaffSplitPitch,
        estimateFingering: options.estimateFingering,
      });
      const partIds = score.parts.map((_, partIndex) =>
        partIndex === 0
          ? partId
          : allocateMusicXmlPartId(
              partIndex === 1 ? `${partId}-percussion` : `${partId}-${partIndex + 1}`,
              usedPartIds,
            ),
      );
      return score.parts.map((part, partIndex) => ({ ...part, id: partIds[partIndex] }));
    });
  if (parts.length === 0) {
    return buildScorePart([], {
      divisionPpq: options.divisionPpq,
      timeSig: options.timeSig,
      keyFifths: options.keyFifths,
      clipStartPpq: options.clipStartPpq,
      clipLengthPpq: options.clipLengthPpq,
      timeSignatures: options.timeSignatures,
      pickupLengthPpq: options.pickupLengthPpq,
      partName: 'Score',
      displayTransposeSemitones: options.displayTransposeSemitones,
      estimateFingering: options.estimateFingering,
    });
  }
  const score: NotatedScore = {
    parts,
    keyFifths: options.keyFifths,
    divisions: DEFAULT_DIVISIONS,
  };
  if (Object.keys(projection.annotations).length > 0) {
    score.noteAnnotations = projection.annotations;
  }
  return score;
}

/** Adds section labels and double bars for section starts aligned to score measures. */
export function applySectionMarks(
  score: NotatedScore,
  sections: ReadonlyArray<EditorSection>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (sections.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const rehearsals: Record<number, string> = {};
  const barlines: Record<number, 'double'> = {};
  for (const section of sections) {
    if (
      section.startPpq < clipStartPpq - PPQ_EPSILON ||
      section.startPpq >= clipEndPpq - PPQ_EPSILON
    ) {
      continue;
    }
    const measureIndex = measureIndexForPpq(score, section.startPpq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const name = section.name.trim();
    if (name) rehearsals[measureIndex] = name;
    if (measureIndex > 0) barlines[measureIndex - 1] = 'double';
  }
  if (Object.keys(rehearsals).length > 0) score.measureRehearsals = rehearsals;
  if (Object.keys(barlines).length > 0) score.measureBarlines = barlines;
}

/** Adds exact metronome marks and textual ramp directions across the score grid. */
export function applyTempoMarks(
  score: NotatedScore,
  tempoSegments: ReadonlyArray<TempoSegment>,
  fallbackBpm: number,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const tempoMap = normalizeTempoMap(tempoSegments, fallbackBpm);
  const tempoMarks: Record<number, NotatedTempoMark[]> = {};
  const tempoTexts: Record<number, NotatedTempoText[]> = {};
  const addTempo = (ppq: number, bpm: number): void => {
    const position = measurePositionForPpq(score, ppq, clipStartPpq, measureLenPpq);
    if (position === undefined) return;
    const marks = tempoMarks[position.measureIndex] ?? [];
    const existing = marks.findIndex(
      (mark) => Math.abs(mark.offsetPpq - position.offsetPpq) <= PPQ_EPSILON,
    );
    const mark = { bpm, offsetPpq: position.offsetPpq };
    if (existing >= 0) marks[existing] = mark;
    else marks.push(mark);
    marks.sort((a, b) => a.offsetPpq - b.offsetPpq);
    tempoMarks[position.measureIndex] = marks;
  };
  const addText = (ppq: number, text: string, bpm?: number): void => {
    const position = measurePositionForPpq(score, ppq, clipStartPpq, measureLenPpq);
    if (position === undefined) return;
    const marks = tempoTexts[position.measureIndex] ?? [];
    marks.push({ text, ...(bpm !== undefined ? { bpm } : {}), offsetPpq: position.offsetPpq });
    marks.sort((a, b) => (a.offsetPpq ?? 0) - (b.offsetPpq ?? 0));
    tempoTexts[position.measureIndex] = marks;
  };
  addTempo(clipStartPpq, tempoAtPpq(tempoMap, clipStartPpq));
  for (const segment of tempoSegments) {
    if (
      segment.startPpq <= clipStartPpq + PPQ_EPSILON ||
      segment.startPpq >= clipEndPpq - PPQ_EPSILON
    ) {
      continue;
    }
    addTempo(segment.startPpq, tempoAtPpq(tempoMap, segment.startPpq));
  }
  const sortedSegments = [...tempoSegments]
    .filter((segment) => Number.isFinite(segment.startPpq))
    .sort((a, b) => a.startPpq - b.startPpq);
  for (let i = 0; i < sortedSegments.length - 1; i += 1) {
    const segment = sortedSegments[i];
    const next = sortedSegments[i + 1];
    if (
      segment.endBpm === undefined ||
      !Number.isFinite(segment.endBpm) ||
      segment.endBpm <= 0 ||
      Math.abs(segment.endBpm - segment.bpm) < PPQ_EPSILON
    ) {
      continue;
    }
    addText(
      segment.startPpq,
      segment.endBpm < segment.bpm ? 'rit.' : 'accel.',
      tempoAtPpq(tempoMap, segment.startPpq),
    );
    addText(next.startPpq, 'a tempo', tempoAtPpq(tempoMap, next.startPpq));
    addTempo(next.startPpq, tempoAtPpq(tempoMap, next.startPpq));
  }
  score.measureTempoMarks = tempoMarks;
  if (Object.keys(tempoTexts).length > 0) score.measureTempoTexts = tempoTexts;
}

/** Adds conservative system/page breaks for printable performance scores. */
export function applyLayoutBreaks(
  score: NotatedScore,
  sections: ReadonlyArray<EditorSection>,
  _clipStartPpq: number,
  measureLenPpq: number,
  settings: Pick<ScoreLayoutSettings, 'barsPerSystem' | 'barsPerPage'> = {
    barsPerSystem: 4,
    barsPerPage: 16,
  },
): void {
  if (measureLenPpq <= 0 || score.parts.length === 0) return;
  const measureCount = score.parts[0].measures.length;
  const breaks: Record<number, 'system' | 'page'> = {};
  const barsPerSystem = Math.max(0, Math.round(settings.barsPerSystem));
  const barsPerPage = Math.max(0, Math.round(settings.barsPerPage));
  if (barsPerSystem > 0) {
    for (let index = barsPerSystem; index < measureCount; index += barsPerSystem) {
      breaks[index] = 'system';
    }
  }
  if (barsPerPage > 0) {
    for (let index = barsPerPage; index < measureCount; index += barsPerPage) {
      breaks[index] = 'page';
    }
  }
  for (const section of sections) {
    const measureIndex = measureIndexForPpq(score, section.startPpq, _clipStartPpq, measureLenPpq);
    if (measureIndex !== undefined && measureIndex > 0 && breaks[measureIndex] !== 'page') {
      breaks[measureIndex] = 'system';
    }
  }
  if (Object.keys(breaks).length > 0) score.measureBreaks = breaks;
}

/** Adds measure-aligned timeline markers as general score text directions. */
export function applyMarkerTexts(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (markers.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const texts: Record<number, Array<{ text: string; defaultY?: number }>> = {};
  for (const marker of markers) {
    if (marker.ppq < clipStartPpq - PPQ_EPSILON || marker.ppq >= clipEndPpq - PPQ_EPSILON) continue;
    if (keySignaturePayload(marker.name) !== null) continue;
    if (lyricPayload(marker.name) !== null) continue;
    const measureIndex = measureIndexForPpq(score, marker.ppq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const text = marker.name.trim();
    if (!text) continue;
    const list = texts[measureIndex] ?? [];
    list.push({ text, defaultY: 24 - list.length * 8 });
    texts[measureIndex] = list;
  }
  if (Object.keys(texts).length > 0) score.measureTexts = texts;
}

/** Adds MusicXML lyrics from "Lyric: ..." timeline markers. */
export function applyLyricMarks(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
): void {
  if (markers.length === 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const attacks = score.parts
    .flatMap((part, partIndex) =>
      part.measures.flatMap((measure) =>
        measure.voices.flatMap((voice) =>
          voice.events.flatMap((event) =>
            event.kind === 'note' && !event.tieStop
              ? [{ ppq: event.startPpq, partId: part.id, partIndex }]
              : [],
          ),
        ),
      ),
    )
    .sort((a, b) => a.ppq - b.ppq || a.partIndex - b.partIndex);
  if (attacks.length === 0) return;
  const lyrics = markers
    .filter((marker) => marker.ppq >= clipStartPpq - PPQ_EPSILON && marker.ppq < clipEndPpq)
    .flatMap((marker) => {
      const lyric = lyricPayload(marker.name);
      if (lyric === null) return [];
      const attack = attacks.reduce((nearest, candidate) =>
        Math.abs(candidate.ppq - marker.ppq) < Math.abs(nearest.ppq - marker.ppq)
          ? candidate
          : nearest,
      );
      return [{ ppq: attack.ppq, markerId: marker.id, ...lyric }];
    })
    .sort((a, b) => a.ppq - b.ppq || a.markerId - b.markerId)
    .map(({ markerId: _markerId, ...lyric }) => lyric);
  if (lyrics.length > 0) score.lyrics = lyrics;
}

/** Transposes a MusicXML fifths value while keeping an enharmonic conventional spelling. */
export function transposeKeyFifths(fifths: number, semitones: number): number {
  const shifted = fifths + semitones * 7;
  const modulo = ((shifted % 12) + 12) % 12;
  return modulo > 6 ? modulo - 12 : modulo;
}

/**
 * Moves root and slash-bass pitch classes alongside display-transposed notes.
 * The display key controls the enharmonic spelling of the rebuilt text.
 */
export function transposeChordSymbols(
  symbols: ReadonlyArray<NotatedChordSymbol>,
  semitones: number,
  displayKeyFifths = 0,
): NotatedChordSymbol[] {
  const shift = ((semitones % 12) + 12) % 12;
  if (shift === 0) return [...symbols];
  const isPitchClass = (pitchClass: number | undefined): pitchClass is number =>
    pitchClass !== undefined && Number.isInteger(pitchClass) && pitchClass >= 0 && pitchClass <= 11;
  const transposePitchClass = (pitchClass: number | undefined): number | undefined =>
    isPitchClass(pitchClass) ? (pitchClass + shift) % 12 : pitchClass;
  const transposeText = (
    symbol: NotatedChordSymbol,
    rootPc: number | undefined,
    bassPc: number | undefined,
  ): string => {
    if (!isPitchClass(rootPc)) return symbol.text;
    const rootToken = symbol.text.match(/^([A-Ga-g](?:#|b|♯|♭)?)/)?.[0];
    if (rootToken === undefined) return symbol.text;
    const remainder = symbol.text.slice(rootToken.length);
    const rootName = chordPitchClassName(rootPc, displayKeyFifths);
    if (!isPitchClass(bassPc)) return `${rootName}${remainder}`;
    const bassToken = remainder.match(/\/([A-Ga-g](?:#|b|♯|♭)?)$/)?.[0];
    if (bassToken === undefined) return `${rootName}${remainder}`;
    const suffix = remainder.slice(0, -bassToken.length);
    return `${rootName}${suffix}/${chordPitchClassName(bassPc, displayKeyFifths)}`;
  };
  return symbols.map((symbol) => {
    const rootPc = transposePitchClass(symbol.rootPc);
    const bassPc = transposePitchClass(symbol.bassPc);
    return {
      ...symbol,
      text: transposeText(symbol, rootPc, bassPc),
      rootPc,
      bassPc,
    };
  });
}

/** Adds MusicXML key-signature changes from measure-aligned "Key: ..." markers. */
export function applyKeySignatureMarks(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
  displayTransposeSemitones = 0,
): void {
  if (markers.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const keyMarkers = markers
    .map((marker) => ({ marker, key: keySignaturePayload(marker.name) }))
    .filter(
      (entry): entry is { marker: EditorMarker; key: { fifths: number } } => entry.key !== null,
    )
    .sort((a, b) => a.marker.ppq - b.marker.ppq || a.marker.id - b.marker.id);
  if (keyMarkers.length === 0) return;

  let activeFifths = score.keyFifths;
  for (const { marker, key } of keyMarkers) {
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON) {
      activeFifths = transposeKeyFifths(key.fifths, displayTransposeSemitones);
    }
  }

  const changes: Record<number, number> = {};
  if (activeFifths !== score.keyFifths) changes[0] = activeFifths;
  for (const { marker, key } of keyMarkers) {
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON || marker.ppq >= clipEndPpq - PPQ_EPSILON) {
      continue;
    }
    const measureIndex = measureIndexForPpq(score, marker.ppq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const fifths = transposeKeyFifths(key.fifths, displayTransposeSemitones);
    if (fifths === activeFifths) continue;
    activeFifths = fifths;
    changes[measureIndex] = fifths;
  }
  if (Object.keys(changes).length > 0) score.measureKeyFifths = changes;
}

/** Marks consecutive empty measures as multi-measure rests when safe. */
export function applyMultiMeasureRests(score: NotatedScore): void {
  if (score.parts.length !== 1) return;
  const measures = score.parts[0].measures;
  const rests: Record<number, { count: number }> = {};
  let start = -1;
  for (let index = 0; index <= measures.length; index += 1) {
    const empty =
      index < measures.length &&
      isEmptyMeasure(measures[index]) &&
      !measureHasMultiRestStructure(score, measures, index);
    if (empty && start < 0) start = index;
    if ((!empty || index === measures.length) && start >= 0) {
      const count = index - start;
      if (count >= 2) rests[start] = { count };
      start = -1;
    }
  }
  if (Object.keys(rests).length > 0) score.multiMeasureRests = rests;
}

function scoreMeasures(score: NotatedScore): ReadonlyArray<NotatedMeasure> {
  return score.parts[0]?.measures ?? [];
}

function measuresUseClipOrigin(
  measures: ReadonlyArray<NotatedMeasure>,
  clipStartPpq: number,
): boolean {
  const first = measures[0];
  return first !== undefined && Math.abs(first.startPpq - clipStartPpq) <= PPQ_EPSILON;
}

function legacyMeasureIndexForPpq(
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
  measureCount: number,
): number | undefined {
  const rel = ppq - clipStartPpq;
  const index = Math.round(rel / measureLenPpq);
  if (index < 0 || index >= measureCount) return undefined;
  return Math.abs(rel - index * measureLenPpq) <= PPQ_EPSILON ? index : undefined;
}

function measureIndexForPpq(
  score: NotatedScore,
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): number | undefined {
  const measures = scoreMeasures(score);
  if (!measuresUseClipOrigin(measures, clipStartPpq)) {
    return legacyMeasureIndexForPpq(ppq, clipStartPpq, measureLenPpq, measures.length);
  }
  for (let index = 0; index < measures.length; index += 1) {
    if (Math.abs(ppq - measures[index].startPpq) <= PPQ_EPSILON) return index;
  }
  return undefined;
}

/** Resolves any in-measure PPQ to the model's variable-meter measure grid. */
function measurePositionForPpq(
  score: NotatedScore,
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): { measureIndex: number; offsetPpq: number } | undefined {
  const measures = scoreMeasures(score);
  if (measuresUseClipOrigin(measures, clipStartPpq)) {
    for (let index = 0; index < measures.length; index += 1) {
      const measure = measures[index];
      const end = measure.startPpq + measure.lengthPpq;
      if (Math.abs(ppq - measure.startPpq) <= PPQ_EPSILON) {
        return { measureIndex: index, offsetPpq: 0 };
      }
      if (ppq > measure.startPpq && ppq < end - PPQ_EPSILON) {
        return { measureIndex: index, offsetPpq: ppq - measure.startPpq };
      }
    }
    return undefined;
  }
  const relative = ppq - clipStartPpq;
  if (relative < -PPQ_EPSILON) return undefined;
  const measureIndex = Math.floor(relative / measureLenPpq + PPQ_EPSILON);
  if (measureIndex < 0 || measureIndex >= measures.length) return undefined;
  return {
    measureIndex,
    offsetPpq: Math.max(0, relative - measureIndex * measureLenPpq),
  };
}

function keySignaturePayload(name: string): { fifths: number } | null {
  const key = keySignatureFromMarker(name);
  return key === null ? null : { fifths: key.fifths };
}

function lyricPayload(name: string): Omit<NotatedLyric, 'ppq' | 'partId'> | null {
  const match = name.trim().match(/^Lyric(?:\s+#?(\d+))?:\s*(.+)$/i);
  if (!match) return null;
  const verse = match[1] === undefined ? undefined : Number(match[1]);
  if (verse !== undefined && (!Number.isInteger(verse) || verse < 1)) return null;
  let text = match[2].trim();
  const syllabicMatch = text.match(/^(single|begin|middle|end):\s*(.+)$/i);
  const syllabic = syllabicMatch?.[1].toLowerCase() as NotatedLyricSyllabic | undefined;
  if (syllabicMatch) text = syllabicMatch[2].trim();
  const extend = text.endsWith('~');
  if (extend) text = text.slice(0, -1).trimEnd();
  return text === ''
    ? null
    : {
        text,
        ...(verse !== undefined ? { verse } : {}),
        ...(syllabic !== undefined ? { syllabic } : {}),
        ...(extend ? { extend } : {}),
      };
}

function isEmptyMeasure(measure: NotatedMeasure): boolean {
  return measure.voices.every(
    (voice) =>
      voice.events.length === 1 &&
      voice.events[0].kind === 'rest' &&
      Math.abs(voice.events[0].startPpq - measure.startPpq) <= PPQ_EPSILON &&
      Math.abs(voice.events[0].durationPpq - measure.lengthPpq) <= PPQ_EPSILON,
  );
}

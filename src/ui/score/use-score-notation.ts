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
  type NotatedLyric,
  type NotatedLyricSyllabic,
  type NotatedMeasure,
  type NotatedScore,
  type NotatedTempoMark,
  type NotatedTempoText,
} from '@/notation/model';
import { extractPartScore, serializeMusicXml } from '@/notation/musicxml';
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
  /** Active transport loop range in project PPQ, or null when disabled/unusable. */
  getLoopRegion?: () => { startPpq: number; endPpq: number } | null;
  /** Current layout settings (page, orientation, margins, scale, spacing). */
  getLayoutSettings: () => ScoreLayoutSettings;
  /** Resets the playhead highlight scan after every render / layout change. */
  resetPlayheadScan: () => void;
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
  /** Bumps the render generation, abandoning any in-flight render's results. */
  bumpGeneration: () => void;
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

/** Wires the non-destructive notation pipeline for the score panel. */
export function useScoreNotation(options: ScoreNotationOptions): ScoreNotation {
  const { store, client } = options;

  const loading = ref(false);
  const exporting = ref(false);
  const error = ref('');
  const svg = ref('');
  const page = ref(1);
  const pageCount = ref(0);

  /** MusicXML of the last successful transcription (export source). */
  let currentXml = '';
  let currentScore: NotatedScore | null = null;
  /** Timemap of the last successful load (paired with the same load's SVG ids). */
  let timemap: ReadonlyArray<VerovioTimemapEntry> = [];
  const screenOperations = new OperationGeneration();
  const exportOperations = new OperationGeneration();
  let activeExportClient: VerovioClient | null = null;
  let activeExportSignal: AbortSignal | undefined;

  function screenIdentity(): OperationIdentity {
    return {
      projectId: store.documentGeneration,
      targetId: store.clipId,
      revision: fnv1a32Hex(
        canonicalJson({
          initialized: store.initialized,
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
          loopRegion: options.getLoopRegion?.(),
          displayTransposeSemitones: store.displayTransposeSemitones,
          projectName: store.projectName,
          layout: options.getLayoutSettings(),
        }),
      ),
    };
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
      client.value = new VerovioClient();
    }
    const verovio = client.value;
    if (!verovio || !store.initialized || store.clipLengthPpq <= 0) return;
    const token = screenOperations.begin(screenIdentity());
    loading.value = true;
    error.value = '';
    try {
      const fifths = options.getKeyFifths();
      const fullScore = options.getFullScoreEnabled?.() === true;
      const scoreProjection = fullScore
        ? buildFullScoreProjection(store, store.clipStartPpq, options.getScreenClipLengthPpq())
        : buildScoreProjection(
            store.activeClip && clipKind(store.activeClip) === 'midi' ? [store.activeClip] : [],
            store.scoreAnnotations,
          );
      const score = fullScore
        ? buildFullScore(
            store,
            {
              divisionPpq: options.getDivisionPpq(),
              timeSig: { ...options.getTimeSig() },
              keyFifths: fifths,
              clipStartPpq: store.clipStartPpq,
              clipLengthPpq: options.getScreenClipLengthPpq(),
              timeSignatures: options.getTimeSignatures?.(),
              pickupLengthPpq: options.getPickupLengthPpq?.(),
              displayTransposeSemitones: store.displayTransposeSemitones,
              grandStaffSplitPitch: options.getGrandStaffSplitPitch?.(),
              estimateFingering: options.getEstimateFingering?.(),
            },
            scoreProjection,
          )
        : quantizeToScore(scoreProjection.notes, {
            divisionPpq: options.getDivisionPpq(),
            timeSig: { ...options.getTimeSig() },
            keyFifths: fifths,
            clipStartPpq: store.clipStartPpq,
            clipLengthPpq: options.getScreenClipLengthPpq(),
            timeSignatures: options.getTimeSignatures?.(),
            pickupLengthPpq: options.getPickupLengthPpq?.(),
            clef: 'grand',
            partName: 'Piano',
            grandStaffSplitPitch: options.getGrandStaffSplitPitch?.(),
            estimateFingering: options.getEstimateFingering?.(),
            // Engraving-only transpose; the underlying MIDI notes never change.
            displayTransposeSemitones: store.displayTransposeSemitones,
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
        store.clipLengthPpq,
        options.getMeasureLenPpq(),
      );
      applyLayoutBreaks(
        score,
        store.sections,
        store.clipStartPpq,
        options.getMeasureLenPpq(),
        options.getLayoutSettings(),
      );
      applyMarkerTexts(
        score,
        store.markers,
        store.clipStartPpq,
        store.clipLengthPpq,
        options.getMeasureLenPpq(),
      );
      applyLyricMarks(score, store.markers, store.clipStartPpq, store.clipLengthPpq);
      applyKeySignatureMarks(
        score,
        store.markers,
        store.clipStartPpq,
        store.clipLengthPpq,
        options.getMeasureLenPpq(),
      );
      applyTempoMarks(
        score,
        store.tempoSegments,
        store.tempoBpm,
        store.clipStartPpq,
        store.clipLengthPpq,
        options.getMeasureLenPpq(),
      );
      applyMultiMeasureRests(score);
      const loopRegion = options.getLoopRegion?.() ?? null;
      if (loopRegion) {
        applyLoopMarks(
          score,
          loopRegion.startPpq,
          loopRegion.endPpq,
          store.clipStartPpq,
          store.clipLengthPpq,
          options.getMeasureLenPpq(),
        );
      }
      if (options.getChordsEnabled()) {
        // Chord symbols are best-effort: any wasm failure degrades silently to
        // a score without harmony instead of failing the whole render.
        try {
          const estimated: EstimatedChordSymbol[] = estimateChordSymbols(scoreProjection.notes, {
            clipStartPpq: store.clipStartPpq,
            clipLengthPpq: options.getScreenClipLengthPpq(),
            measureLengthPpq: options.getMeasureLenPpq(),
            measures: score.parts[0]?.measures,
            keyFifths: fifths,
          });
          const symbols = await canonicalizeChordSymbols(estimated);
          if (!screenOperationIsCurrent(token, verovio)) return;
          if (symbols.length > 0) score.chordSymbols = symbols;
        } catch {
          // Degrade silently: render the score without chord symbols.
        }
      }
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
      currentScore = score;
      currentXml = xml;
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
    const token = screenOperations.begin(screenIdentity());
    verovio.cancelPending(new DOMException('Score refresh superseded.', 'AbortError'));
    loading.value = true;
    error.value = '';
    try {
      const pageSvg = await verovio.renderPage(page.value);
      if (!screenOperationIsCurrent(token, verovio)) return;
      svg.value = pageSvg;
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
    if (!verovio || pageCount.value === 0) {
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
    if (!currentXml) return 0;
    const xmlSnapshot = String(currentXml);
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
        () => exportOperations.isCurrent(token, exportIdentity(xmlSnapshot, settingsSnapshot)),
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
    if (!currentXml) return;
    void runExport(async () => {
      exportMusicXml(currentXml, projectFilename(store.projectName, '.musicxml', 'score'));
    });
  }

  function onExportPartMusicXml(): void {
    if (!currentScore || currentScore.parts.length === 0) return;
    const score = currentScore;
    void runExport(async () => {
      const partScore = extractPartScore(score, 0);
      const xml = serializeMusicXml(partScore);
      exportMusicXml(xml, projectFilename(store.projectName, '.part.musicxml', 'score-part'));
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
    getCurrentXml: () => currentXml,
    bumpGeneration: () => {
      screenOperations.invalidate();
      exportOperations.invalidate();
      client.value?.cancelPending();
      activeExportClient?.dispose();
      activeExportClient = null;
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

export function buildFullScore(
  store: ProjectStore,
  options: FullScoreBuildOptions,
  projection = buildFullScoreProjection(store, options.clipStartPpq, options.clipLengthPpq),
): NotatedScore {
  const parts = store.tracks
    .filter((track) => track.kind === 'midi')
    .flatMap((track, index) => {
      const notes = projection.notesByTrack.get(track.id) ?? [];
      const score = quantizeToScore(notes, {
        divisionPpq: options.divisionPpq,
        timeSig: options.timeSig,
        keyFifths: options.keyFifths,
        clipStartPpq: options.clipStartPpq,
        clipLengthPpq: options.clipLengthPpq,
        timeSignatures: options.timeSignatures,
        pickupLengthPpq: options.pickupLengthPpq,
        partId: `P${index + 1}`,
        partName: track.name || `Track ${index + 1}`,
        displayTransposeSemitones: options.displayTransposeSemitones,
        grandStaffSplitPitch: options.grandStaffSplitPitch,
        estimateFingering: options.estimateFingering,
      });
      return score.parts;
    });
  if (parts.length === 0) {
    return quantizeToScore([], {
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

/** Adds repeat marks for an active loop range aligned to score measures. */
export function applyLoopMarks(
  score: NotatedScore,
  loopStartPpq: number,
  loopEndPpq: number,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (measureLenPpq <= 0 || score.parts.length === 0) return;
  if (loopEndPpq <= loopStartPpq + PPQ_EPSILON) return;
  const measureCount = score.parts[0].measures.length;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  if (loopStartPpq < clipStartPpq - PPQ_EPSILON || loopEndPpq > clipEndPpq + PPQ_EPSILON) return;
  const startIndex = measureIndexForPpq(score, loopStartPpq, clipStartPpq, measureLenPpq);
  const endBoundaryIndex = measureBoundaryIndexForPpq(
    score,
    loopEndPpq,
    clipStartPpq,
    measureLenPpq,
  );
  if (startIndex === undefined || endBoundaryIndex === undefined) return;
  if (startIndex < 0 || startIndex >= measureCount || endBoundaryIndex <= startIndex) return;
  if (endBoundaryIndex > measureCount) return;
  const endIndex = endBoundaryIndex - 1;
  const repeats: Record<number, 'start' | 'end' | 'start-end'> = {
    ...(score.measureRepeats ?? {}),
  };
  repeats[startIndex] = repeats[startIndex] === 'end' ? 'start-end' : 'start';
  repeats[endIndex] = repeats[endIndex] === 'start' ? 'start-end' : 'end';
  score.measureRepeats = repeats;
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
  const lyrics = markers
    .filter((marker) => marker.ppq >= clipStartPpq - PPQ_EPSILON && marker.ppq < clipEndPpq)
    .sort((a, b) => a.ppq - b.ppq || a.id - b.id)
    .flatMap((marker) => {
      const lyric = lyricPayload(marker.name);
      return lyric === null ? [] : [{ ppq: marker.ppq, ...lyric }];
    });
  if (lyrics.length > 0) score.lyrics = lyrics;
}

/** Adds MusicXML key-signature changes from measure-aligned "Key: ..." markers. */
export function applyKeySignatureMarks(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
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
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON) activeFifths = key.fifths;
  }

  const changes: Record<number, number> = {};
  if (activeFifths !== score.keyFifths) changes[0] = activeFifths;
  for (const { marker, key } of keyMarkers) {
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON || marker.ppq >= clipEndPpq - PPQ_EPSILON) {
      continue;
    }
    const measureIndex = measureIndexForPpq(score, marker.ppq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    if (key.fifths === activeFifths) continue;
    activeFifths = key.fifths;
    changes[measureIndex] = key.fifths;
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
    const empty = index < measures.length && isEmptyMeasure(measures[index]);
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

function measureBoundaryIndexForPpq(
  score: NotatedScore,
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): number | undefined {
  const measures = scoreMeasures(score);
  if (!measuresUseClipOrigin(measures, clipStartPpq)) {
    const rel = ppq - clipStartPpq;
    const index = Math.round(rel / measureLenPpq);
    if (index < 0 || index > measures.length) return undefined;
    return Math.abs(rel - index * measureLenPpq) <= PPQ_EPSILON ? index : undefined;
  }
  const startIndex = measureIndexForPpq(score, ppq, clipStartPpq, measureLenPpq);
  if (startIndex !== undefined) return startIndex;
  const last = measures[measures.length - 1];
  if (last && Math.abs(ppq - (last.startPpq + last.lengthPpq)) <= PPQ_EPSILON) {
    return measures.length;
  }
  return undefined;
}

function keySignaturePayload(name: string): { fifths: number } | null {
  const match = name.trim().match(/^Key:\s*([A-G](?:b|#)?)\s+(major|minor)$/i);
  if (!match) return null;
  const tonic = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  const mode = match[2].toLowerCase();
  const major = new Map([
    ['Cb', -7],
    ['Gb', -6],
    ['Db', -5],
    ['Ab', -4],
    ['Eb', -3],
    ['Bb', -2],
    ['F', -1],
    ['C', 0],
    ['G', 1],
    ['D', 2],
    ['A', 3],
    ['E', 4],
    ['B', 5],
    ['F#', 6],
    ['C#', 7],
  ]);
  const minor = new Map([
    ['Ab', -7],
    ['Eb', -6],
    ['Bb', -5],
    ['F', -4],
    ['C', -3],
    ['G', -2],
    ['D', -1],
    ['A', 0],
    ['E', 1],
    ['B', 2],
    ['F#', 3],
    ['C#', 4],
    ['G#', 5],
    ['D#', 6],
    ['A#', 7],
  ]);
  const fifths = mode === 'major' ? major.get(tonic) : minor.get(tonic);
  return fifths === undefined ? null : { fifths };
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

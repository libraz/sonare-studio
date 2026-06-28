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
import { projectFilename } from '@/lib/filename';
import {
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import { exportMusicXml } from '@/notation/io';
import { serializeMusicXml } from '@/notation/musicxml';
import { downloadBlob, exportPdf, printScore } from '@/notation/print';
import { quantizeToScore } from '@/notation/quantize';
import { VerovioClient, type VerovioTimemapEntry } from '@/notation/verovio';
import type { useProjectStore } from '@/project/store';
import {
  type ScoreLayoutSettings,
  scorePageDimsMm,
  scorePrintLayoutOptions,
  scoreScreenLayoutOptions,
} from '@/ui/score/layout';

type ProjectStore = ReturnType<typeof useProjectStore>;

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
  /** Key signature fifths derived from the scale highlight configuration. */
  getKeyFifths: () => number;
  /** True when chord symbols should be estimated and engraved. */
  getChordsEnabled: () => boolean;
  /** Current layout settings (page, orientation, margins, scale, spacing). */
  getLayoutSettings: () => ScoreLayoutSettings;
  /** Resets the playhead highlight scan after every render / layout change. */
  resetPlayheadScan: () => void;
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
  /** Timemap of the last successful load (paired with the same load's SVG ids). */
  let timemap: ReadonlyArray<VerovioTimemapEntry> = [];

  let generation = 0;

  /** Verovio layout options for the current settings (page units are 1/10 mm). */
  function layoutOptions() {
    return scorePrintLayoutOptions(options.getLayoutSettings());
  }

  /**
   * On-screen layout: one continuous system with NO line/system breaks, cropped
   * to the content on both axes. The engraved strip then scrolls horizontally
   * instead of wrapping to multiple lines. Print/PDF use the paginated
   * `layoutOptions()` above instead.
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
    const gen = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const fifths = options.getKeyFifths();
      const score = quantizeToScore(store.notes, {
        divisionPpq: options.getDivisionPpq(),
        timeSig: { ...options.getTimeSig() },
        keyFifths: fifths,
        clipStartPpq: store.clipStartPpq,
        clipLengthPpq: options.getScreenClipLengthPpq(),
        clef: 'grand',
        partName: 'Piano',
        // Engraving-only transpose; the underlying MIDI notes never change.
        displayTransposeSemitones: store.displayTransposeSemitones,
      });
      const title = store.projectName.trim();
      if (title) score.metadata = { title };
      const annotations = store.scoreAnnotations[store.clipId];
      if (annotations && Object.keys(annotations).length > 0) {
        score.noteAnnotations = { ...annotations };
      }
      if (options.getChordsEnabled()) {
        // Chord symbols are best-effort: any wasm failure degrades silently to
        // a score without harmony instead of failing the whole render.
        try {
          const estimated: EstimatedChordSymbol[] = estimateChordSymbols(store.notes, {
            clipStartPpq: store.clipStartPpq,
            clipLengthPpq: store.clipLengthPpq,
            measureLengthPpq: options.getMeasureLenPpq(),
            keyFifths: fifths,
          });
          const symbols = await canonicalizeChordSymbols(estimated);
          if (symbols.length > 0) score.chordSymbols = symbols;
        } catch {
          // Degrade silently: render the score without chord symbols.
        }
      }
      const xml = serializeMusicXml(score);
      const count = await verovio.load(xml, screenLayoutOptions());
      if (gen !== generation) return;
      currentXml = xml;
      pageCount.value = count;
      page.value = Math.min(Math.max(page.value, 1), Math.max(count, 1));
      const [pageSvg, entries] = await Promise.all([
        verovio.renderPage(page.value),
        verovio.getTimemap(),
      ]);
      if (gen !== generation) return;
      svg.value = pageSvg;
      timemap = entries;
      options.resetPlayheadScan();
    } catch (err) {
      if (gen !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  /** Re-renders the current page from the already loaded score. */
  async function refresh(): Promise<void> {
    const verovio = client.value;
    if (!verovio || pageCount.value === 0) return;
    const gen = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const pageSvg = await verovio.renderPage(page.value);
      if (gen !== generation) return;
      svg.value = pageSvg;
      options.resetPlayheadScan();
    } catch (err) {
      if (gen !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  /** Applies the layout settings to the loaded score and re-renders. */
  async function applyLayout(): Promise<void> {
    const verovio = client.value;
    if (!verovio || pageCount.value === 0) {
      void transcribe();
      return;
    }
    const gen = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const count = await verovio.setLayout(screenLayoutOptions());
      if (gen !== generation) return;
      pageCount.value = count;
      page.value = Math.min(Math.max(page.value, 1), Math.max(count, 1));
      // Note ids survive redoLayout, so the existing timemap stays valid.
      const pageSvg = await verovio.renderPage(page.value);
      if (gen !== generation) return;
      svg.value = pageSvg;
      options.resetPlayheadScan();
    } catch (err) {
      if (gen !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  function gotoPage(target: number): void {
    if (pageCount.value === 0) return;
    const next = Math.min(Math.max(target, 1), pageCount.value);
    if (next === page.value) return;
    page.value = next;
    void refresh();
  }

  /**
   * Renders every page for print/export using the PAGINATED A4 layout (the
   * on-screen view is a single continuous system, which would print as one
   * oversized strip), then restores the continuous screen layout.
   */
  async function renderAllPages(): Promise<string[]> {
    const verovio = client.value;
    if (!verovio || pageCount.value === 0) return [];
    try {
      const count = await verovio.setLayout(layoutOptions());
      const pages: string[] = [];
      for (let p = 1; p <= count; p++) {
        pages.push(await verovio.renderPage(p));
      }
      return pages;
    } finally {
      // Restore the on-screen continuous layout and re-render the current page.
      const screenCount = await verovio.setLayout(screenLayoutOptions());
      pageCount.value = screenCount;
      page.value = Math.min(Math.max(page.value, 1), Math.max(screenCount, 1));
      svg.value = await verovio.renderPage(page.value);
      options.resetPlayheadScan();
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
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      exporting.value = false;
    }
  }

  function onPrint(): void {
    void runExport(async () => {
      const pages = await renderAllPages();
      if (pages.length > 0) printScore(pages, scorePageDimsMm(options.getLayoutSettings()));
    });
  }

  function onExportPdf(): void {
    void runExport(async () => {
      const pages = await renderAllPages();
      if (pages.length === 0) return;
      const blob = await exportPdf(pages, scorePageDimsMm(options.getLayoutSettings()));
      downloadBlob(blob, projectFilename(store.projectName, '.pdf', 'score'));
    });
  }

  function onExportMusicXml(): void {
    if (!currentXml) return;
    void runExport(async () => {
      exportMusicXml(currentXml, projectFilename(store.projectName, '.musicxml', 'score'));
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
      generation++;
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
  };
}

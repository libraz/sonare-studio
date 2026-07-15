/**
 * Mastering preview state machine.
 *
 * Renders a short mixdown window twice — once with the project mastering
 * chain ('processed') and once with the chain stripped from the document
 * ('bypassed') — through an injectable render function (the export worker
 * client in the app). Results are cached under a content key derived from
 * the document and range, so re-previewing an unchanged project is free; a
 * generation token discards results from superseded or cancelled renders.
 * The controller never touches the realtime engine.
 */

import type { ExportRenderOptions } from '@/export/client';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownRangePpq,
  type MixdownResult,
} from '@/export/mixdown';
import { OperationGeneration } from '@/lib/operation-generation';
import { canonicalJson, fnv1a32Hex } from '@/project/hash';
import type { ProjectDocument } from '@/project/serialization';

/** A render in flight: result promise plus a cancellation hook. */
export interface PreviewRenderHandle {
  result: Promise<MixdownResult>;
  cancel(): void;
}

/** Renders a document window (the export worker client in production). */
export type PreviewRenderFn = (
  doc: ProjectDocument,
  options: ExportRenderOptions,
  onProgress?: MixdownProgressFn,
) => PreviewRenderHandle;

/** Lifecycle phase of the preview controller. */
export type PreviewStatus = 'idle' | 'rendering' | 'ready' | 'error';

/** Immutable snapshot of the preview controller state. */
export interface MasteringPreviewState {
  status: PreviewStatus;
  /** Combined render progress over both variants (0..1). */
  progress: number;
  /** Last reported render stage (dotted ids, '' when not rendering). */
  stage: string;
  /** Render failure message (status 'error' only). */
  error: string | null;
  /** Cache key of the ready results; null until the first success. */
  key: string | null;
  /** Render with the mastering chain applied. */
  processed: MixdownResult | null;
  /** Render with the chain stripped (A/B comparison baseline). */
  bypassed: MixdownResult | null;
}

/** Options for {@link createMasteringPreviewController}. */
export interface MasteringPreviewControllerOptions {
  /** Render function (export worker client in the app; fake in tests). */
  render: PreviewRenderFn;
  /** Notified after every state change with a fresh snapshot. */
  onChange?: (state: MasteringPreviewState) => void;
}

/** The mastering preview state machine. */
export interface MasteringPreviewController {
  /** Returns a snapshot of the current state. */
  state(): MasteringPreviewState;
  /**
   * Renders both preview variants for a document window, reusing the cache
   * when the key matches. Resolves true when the results were applied
   * (cache hit or completed render), false when superseded, cancelled or
   * failed.
   */
  request(doc: ProjectDocument, range: MixdownRangePpq, sampleRate?: number): Promise<boolean>;
  /** Cancels the in-flight render, keeping the last ready results. */
  cancel(): void;
  /** Cancels and detaches; further requests resolve false. */
  dispose(): void;
}

/**
 * Cache key of one preview render: a content hash over the document, the
 * range and the output sample rate.
 *
 * @param doc Plain project document.
 * @param range Preview window in PPQ.
 * @param sampleRate Output sample rate override, when set.
 * @returns A short stable hex key.
 */
export function previewCacheKey(
  doc: ProjectDocument,
  range: MixdownRangePpq,
  sampleRate?: number,
): string {
  return fnv1a32Hex(canonicalJson({ doc, range, sampleRate: sampleRate ?? null }));
}

/**
 * Returns a document with the mastering chain removed (the A/B baseline).
 * Documents without a chain are returned as-is; the master strip and all
 * track processing stay untouched.
 *
 * @param doc Plain project document (not mutated).
 * @returns The stripped document.
 */
export function stripMasteringChain(doc: ProjectDocument): ProjectDocument {
  if (!doc.mixer?.masteringChain) return doc;
  const mixer = { ...doc.mixer };
  delete mixer.masteringChain;
  return { ...doc, mixer };
}

/**
 * Creates a preview controller over a render function.
 *
 * @param options Render function and change callback.
 * @returns The controller.
 */
export function createMasteringPreviewController(
  options: MasteringPreviewControllerOptions,
): MasteringPreviewController {
  let state: MasteringPreviewState = {
    status: 'idle',
    progress: 0,
    stage: '',
    error: null,
    key: null,
    processed: null,
    bypassed: null,
  };
  const operations = new OperationGeneration();
  /** Handles of the renders belonging to the current generation. */
  let activeHandles: PreviewRenderHandle[] = [];

  function update(patch: Partial<MasteringPreviewState>): void {
    state = { ...state, ...patch };
    if (!operations.disposed) options.onChange?.(state);
  }

  /** Cancels in-flight renders without touching the state. */
  function cancelHandles(): void {
    const handles = activeHandles;
    activeHandles = [];
    for (const handle of handles) handle.cancel();
  }

  async function request(
    doc: ProjectDocument,
    range: MixdownRangePpq,
    sampleRate?: number,
  ): Promise<boolean> {
    if (operations.disposed) return false;
    const snapshot = structuredClone(doc) as ProjectDocument;
    const rangeSnapshot = { ...range };
    const key = previewCacheKey(snapshot, rangeSnapshot, sampleRate);
    if (state.status === 'ready' && state.key === key) return true;
    const token = operations.begin({
      projectId: snapshot.name,
      targetId: 'mastering-preview',
      revision: key,
    });
    cancelHandles();
    update({ status: 'rendering', progress: 0, stage: '', error: null });

    const stripped = stripMasteringChain(snapshot);
    const strippedKey = previewCacheKey(stripped, rangeSnapshot, sampleRate);
    const needsBypassRender = strippedKey !== key;
    const renderOptions: ExportRenderOptions = { range: rangeSnapshot };
    if (sampleRate !== undefined) renderOptions.sampleRate = sampleRate;

    /** Runs one variant render mapped onto a progress sub-window. */
    function renderVariant(
      variantDoc: ProjectDocument,
      from: number,
      to: number,
    ): Promise<MixdownResult> {
      const handle = options.render(variantDoc, renderOptions, (progress, stage) => {
        if (!operations.isCurrent(token)) return;
        update({ progress: from + progress * (to - from), stage });
      });
      activeHandles.push(handle);
      return handle.result;
    }

    try {
      const processed = await renderVariant(snapshot, 0, needsBypassRender ? 0.5 : 1);
      if (!operations.isCurrent(token)) return false;
      const bypassed = needsBypassRender ? await renderVariant(stripped, 0.5, 1) : processed;
      if (!operations.isCurrent(token)) return false;
      activeHandles = [];
      update({ status: 'ready', progress: 1, stage: '', key, processed, bypassed });
      return true;
    } catch (error) {
      if (!operations.isCurrent(token)) return false;
      activeHandles = [];
      if (error instanceof MixdownCancelledError) {
        update({ status: state.key !== null ? 'ready' : 'idle', progress: 0, stage: '' });
      } else {
        update({
          status: 'error',
          progress: 0,
          stage: '',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  }

  function cancel(): void {
    operations.invalidate(new DOMException('Mastering preview cancelled.', 'AbortError'));
    cancelHandles();
    if (state.status === 'rendering') {
      update({ status: state.key !== null ? 'ready' : 'idle', progress: 0, stage: '' });
    }
  }

  function dispose(): void {
    if (operations.disposed) return;
    cancel();
    operations.dispose();
  }

  return { state: () => state, request, cancel, dispose };
}

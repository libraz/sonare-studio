/**
 * Keeping a paged audio clip fed through an offline render.
 *
 * The engine can pull a clip's audio from a page provider instead of holding
 * its whole decoded buffer, which is what stops a render's peak payload growing
 * with the project's total PCM. This module owns the providers and the resident
 * window; which clips qualify is decided in clip-page-plan.ts, and creating a
 * provider is a caller-supplied seam ({@link ClipPageBindingFactory}) because
 * reading storage needs a context this module has no business knowing about.
 *
 * Nothing here depends on the project model, so the window policy can be driven
 * against a real engine directly.
 */

import { KIBIBYTE, MEBIBYTE } from '@/lib/bytes';

/** Bytes per stored sample (little-endian float32). */
const BYTES_PER_SAMPLE = 4;

/** Pages held ahead of the render position. */
export const CLIP_STREAM_PAGES_AHEAD = 1;

/** Pages retained behind the render position. */
export const CLIP_STREAM_PAGES_BEHIND = 1;

/** Resident pages per streamed clip: the current page plus its window. */
export const CLIP_STREAM_WINDOW_PAGES = CLIP_STREAM_PAGES_AHEAD + CLIP_STREAM_PAGES_BEHIND + 1;

/**
 * Total PCM a render may keep resident across every streamed clip. Page reads
 * are serialized per clip, so a page too small turns the render into a stall
 * chain; this budget buys back throughput while staying far below what the
 * decoded path would have held.
 */
export const DEFAULT_CLIP_STREAM_RESIDENT_BUDGET_BYTES = 64 * MEBIBYTE;

/** Smallest page worth reading (below this, per-read overhead dominates). */
export const MIN_CLIP_STREAM_PAGE_BYTES = 256 * KIBIBYTE;

/** Largest page, so one long clip cannot claim the whole budget. */
export const MAX_CLIP_STREAM_PAGE_BYTES = 4 * MEBIBYTE;

/** One audio clip segment the render can read straight from its asset. */
export interface AudioClipStreamPlan {
  /** Identifies the clip segment this plan stands in for. */
  key: string;
  /** Engine track id the clip plays on. */
  trackId: number;
  /** Stored asset the clip reads. */
  assetId: string;
  /** Timeline position in PPQ. */
  startPpq: number;
  /** Linear clip gain. */
  gain: number;
  /** Channel count of the stored asset. */
  numChannels: number;
  /** First frame of the asset the clip plays. */
  sourceStartFrame: number;
  /** Frames the clip plays (its `lengthSamples`). */
  frameCount: number;
  /** Render frame the clip starts at, for mapping a position onto a page. */
  timelineStartFrame: number;
}

/**
 * Page size for one streamed clip, in frames. Derived from a byte budget so a
 * many-channel asset does not silently hold several times the memory a stereo
 * one does, and never larger than the clip's own share of the window: a clip
 * barely longer than a page would otherwise keep more resident than decoding it
 * whole would have cost.
 */
export function clipStreamPageFrames(
  numChannels: number,
  frameCount: number,
  budgetBytes: number,
): number {
  const clamped = Math.min(
    MAX_CLIP_STREAM_PAGE_BYTES,
    Math.max(MIN_CLIP_STREAM_PAGE_BYTES, budgetBytes),
  );
  const frames = Math.floor(clamped / (numChannels * BYTES_PER_SAMPLE));
  return Math.max(1, Math.min(Math.ceil(frameCount / CLIP_STREAM_WINDOW_PAGES), frames));
}

/**
 * Per-clip page byte budget for a whole render: the resident budget shared
 * between every streamed clip and the pages each one keeps.
 */
export function clipStreamPageBudgetBytes(
  clipCount: number,
  residentBudgetBytes = DEFAULT_CLIP_STREAM_RESIDENT_BUDGET_BYTES,
): number {
  if (clipCount <= 0) return MAX_CLIP_STREAM_PAGE_BYTES;
  return Math.floor(residentBudgetBytes / (clipCount * CLIP_STREAM_WINDOW_PAGES));
}

/** What a {@link ClipPageBindingFactory} needs to serve one clip's pages. */
export interface ClipPageBindingRequest {
  /** Stored asset the pages are read from. */
  assetId: string;
  /** Channel count of the stored asset. */
  numChannels: number;
  /** Frames served, counted from `dataOffsetFrames`. */
  numSamples: number;
  /** Page size in frames. */
  pageFrames: number;
  /** First frame of the asset page 0 starts at. */
  dataOffsetFrames: number;
}

/** The page-provider surface a render needs; libsonare's binding satisfies it. */
export interface ClipPageBinding {
  /** Handle passed to `setClips` as the clip's `pageProvider`. */
  provider: unknown;
  /** Reads one page into the engine; false when the page could not be read. */
  supplyPage(pageIndex: number): Promise<boolean>;
  /** Evicts one resident page. */
  clearPage?(pageIndex: number): void;
  /** Releases the provider and its reader. */
  close(): void;
}

/** Creates a page provider for one clip. */
export type ClipPageBindingFactory = (
  request: ClipPageBindingRequest,
) => ClipPageBinding | Promise<ClipPageBinding>;

/** A clip scheduled from a page provider rather than a decoded buffer. */
export interface PagedClipSpec {
  trackId: number;
  pageProvider: unknown;
  startPpq: number;
  lengthSamples: number;
  gain: number;
}

/** Thrown when a page the render is about to play could not be read. */
export class ClipPageReadError extends Error {
  constructor(
    readonly assetId: string,
    readonly pageIndex: number,
  ) {
    super(`Audio asset "${assetId}": page ${pageIndex} could not be read`);
    this.name = 'ClipPageReadError';
  }
}

interface StreamState {
  plan: AudioClipStreamPlan;
  binding: ClipPageBinding;
  pageFrames: number;
  lastPage: number;
  resident: Set<number>;
}

/**
 * Owns one render pass's page providers and slides each clip's resident window
 * along with the render position.
 *
 * An offline render is sequential and has no deadline, so the window is driven
 * from the position the render is about to read: every page is resident before
 * its block renders, and the engine's look-ahead requests have nothing to add.
 */
export class AudioClipStreamSession {
  private readonly streams: StreamState[];
  private closed = false;

  private constructor(streams: StreamState[]) {
    this.streams = streams;
  }

  /**
   * Creates a provider per plan; one session serves one render pass.
   *
   * @param plans Streamable clips from {@link planAudioClipStreams}.
   * @param createBinding Provider factory seam.
   * @param options Resident budget override.
   */
  static async open(
    plans: ReadonlyArray<AudioClipStreamPlan>,
    createBinding: ClipPageBindingFactory,
    options: { residentBudgetBytes?: number } = {},
  ): Promise<AudioClipStreamSession> {
    const pageBudget = clipStreamPageBudgetBytes(plans.length, options.residentBudgetBytes);
    const streams: StreamState[] = [];
    try {
      for (const plan of plans) {
        const pageFrames = clipStreamPageFrames(plan.numChannels, plan.frameCount, pageBudget);
        const binding = await createBinding({
          assetId: plan.assetId,
          numChannels: plan.numChannels,
          numSamples: plan.frameCount,
          pageFrames,
          dataOffsetFrames: plan.sourceStartFrame,
        });
        streams.push({
          plan,
          binding,
          pageFrames,
          lastPage: Math.ceil(plan.frameCount / pageFrames) - 1,
          resident: new Set(),
        });
      }
    } catch (error) {
      for (const stream of streams) stream.binding.close();
      throw error;
    }
    return new AudioClipStreamSession(streams);
  }

  /** Clip specs to hand to `setClips`, in plan order. */
  clipSpecs(): PagedClipSpec[] {
    return this.streams.map((stream) => ({
      trackId: stream.plan.trackId,
      pageProvider: stream.binding.provider,
      startPpq: stream.plan.startPpq,
      lengthSamples: stream.plan.frameCount,
      gain: stream.plan.gain,
    }));
  }

  /**
   * Resident PCM across every streamed clip once its window is full. Exact as
   * long as no render block is longer than the read-ahead, which is the case
   * for any page above a few thousand frames.
   */
  residentBytesUpperBound(): number {
    return this.streams.reduce(
      (sum, stream) =>
        sum +
        Math.min(stream.lastPage + 1, CLIP_STREAM_WINDOW_PAGES) *
          stream.pageFrames *
          stream.plan.numChannels *
          BYTES_PER_SAMPLE,
      0,
    );
  }

  /**
   * Makes every page the next block reads resident and evicts the rest. Awaits
   * the reads, so the engine never reads a page that is not there.
   *
   * @param frame Render frame the next block starts at.
   * @param blockFrames Frames that block covers (the window spans all of them).
   * @throws ClipPageReadError when a needed page could not be read.
   */
  async advance(frame: number, blockFrames = 1): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      this.streams.map((stream) => this.advanceStream(stream, frame, Math.max(1, blockFrames))),
    );
  }

  private async advanceStream(
    stream: StreamState,
    frame: number,
    blockFrames: number,
  ): Promise<void> {
    const local = frame - stream.plan.timelineStartFrame;
    // Before the clip starts, hold its opening pages ready; past its end, let
    // the window drain so a finished clip stops occupying memory.
    const played = local < stream.plan.frameCount;
    const centre = Math.max(0, Math.floor(local / stream.pageFrames));
    // A block may straddle a page boundary; the read-ahead already covers the
    // next page, so the window only grows for a block longer than the whole
    // read-ahead — which keeps the resident set at CLIP_STREAM_WINDOW_PAGES.
    const last = Math.max(centre, Math.floor((local + blockFrames - 1) / stream.pageFrames));
    const low = played ? Math.max(0, centre - CLIP_STREAM_PAGES_BEHIND) : 0;
    const high = played
      ? Math.min(stream.lastPage, Math.max(last, centre + CLIP_STREAM_PAGES_AHEAD))
      : -1;
    for (const page of [...stream.resident]) {
      if (page < low || page > high) {
        stream.binding.clearPage?.(page);
        stream.resident.delete(page);
      }
    }
    const reads: Array<Promise<void>> = [];
    for (let page = low; page <= high; page += 1) {
      if (stream.resident.has(page)) continue;
      stream.resident.add(page);
      const pageIndex = page;
      reads.push(
        stream.binding.supplyPage(pageIndex).then(
          (ok) => {
            if (ok) return;
            stream.resident.delete(pageIndex);
            throw new ClipPageReadError(stream.plan.assetId, pageIndex);
          },
          (error) => {
            stream.resident.delete(pageIndex);
            throw error;
          },
        ),
      );
    }
    await Promise.all(reads);
  }

  /** Releases every provider. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) stream.binding.close();
    this.streams.length = 0;
  }
}

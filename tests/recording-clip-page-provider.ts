/**
 * A real libsonare `ClipPageProvider` that also records what it was handed, so
 * a spec can assert on the pages a render supplied. Install it with
 * `vi.mock('@/wasm/index.js', ...)` through {@link withRecordingClipPageProvider};
 * the core module must be initialized before a provider is constructed.
 */
import type * as Core from '@/wasm/index.js';

export interface RecordedClipPageProvider {
  provider: Core.ClipPageProvider;
  numChannels: number;
  numSamples: number;
  pageFrames: number;
  /** Pages currently resident, as last supplied. */
  pages: Map<number, Float32Array[]>;
  /** Most pages this provider held resident at once. */
  peakPages: number;
  supplied: number[];
  cleared: number[];
  destroyed: boolean;
}

/** Every provider constructed since the last {@link resetRecordedClipPageProviders}. */
export const recordedClipPageProviders: RecordedClipPageProvider[] = [];

export function resetRecordedClipPageProviders(): void {
  recordedClipPageProviders.length = 0;
}

/** The recorded entry for a provider handed to the engine, if it is one of ours. */
export function recordedClipPageProvider(provider: unknown): RecordedClipPageProvider | undefined {
  return recordedClipPageProviders.find((entry) => entry.provider === provider);
}

/** The core module with `ClipPageProvider` replaced by the recording subclass. */
export function withRecordingClipPageProvider(actual: typeof Core): typeof Core {
  class RecordingClipPageProvider extends actual.ClipPageProvider {
    private readonly entry: RecordedClipPageProvider;

    constructor(options: Core.ClipPageProviderOptions) {
      super(options);
      this.entry = {
        provider: this,
        numChannels: options.numChannels,
        numSamples: options.numSamples,
        pageFrames: options.pageFrames,
        pages: new Map(),
        peakPages: 0,
        supplied: [],
        cleared: [],
        destroyed: false,
      };
      recordedClipPageProviders.push(this.entry);
    }

    override supply(pageIndex: number, channels: Float32Array[]): void {
      super.supply(pageIndex, channels);
      this.entry.pages.set(pageIndex, channels);
      this.entry.supplied.push(pageIndex);
      this.entry.peakPages = Math.max(this.entry.peakPages, this.entry.pages.size);
    }

    override clear(pageIndex: number): void {
      super.clear(pageIndex);
      this.entry.pages.delete(pageIndex);
      this.entry.cleared.push(pageIndex);
    }

    override destroy(): void {
      super.destroy();
      this.entry.pages.clear();
      this.entry.destroyed = true;
    }
  }
  return { ...actual, ClipPageProvider: RecordingClipPageProvider };
}

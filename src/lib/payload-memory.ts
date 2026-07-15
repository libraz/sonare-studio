/** Deterministic payload accounting with optional browser-heap sampling. */

export interface PayloadMemorySample {
  label: string;
  unit: string;
  activeBytes: number;
  peakActiveBytes: number;
  processedUnits: number;
  browserHeapBytes?: number;
  peakBrowserHeapBytes?: number;
}

export interface PayloadMemoryMeterOptions {
  label: string;
  budgetBytes: number;
  onSample?: (sample: PayloadMemorySample) => void;
  readBrowserHeapBytes?: () => number | undefined;
}

/** Error raised before an operation retains more payload than its configured budget. */
export class PayloadMemoryLimitError extends Error {
  readonly requiredBytes: number;
  readonly budgetBytes: number;
  readonly operation: string;

  constructor(operation: string, requiredBytes: number, budgetBytes: number) {
    const requiredMiB = Math.ceil(requiredBytes / (1024 * 1024));
    const budgetMiB = Math.floor(budgetBytes / (1024 * 1024));
    super(
      `${operation} needs about ${requiredMiB} MiB of working memory, exceeding the ${budgetMiB} MiB browser budget. Shorten the range, lower the sample rate, or export fewer pages.`,
    );
    this.name = 'PayloadMemoryLimitError';
    this.operation = operation;
    this.requiredBytes = requiredBytes;
    this.budgetBytes = budgetBytes;
  }
}

type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize?: number };
};

/** Reads Chromium's non-standard heap counter when available. */
export function readBrowserHeapBytes(): number | undefined {
  const value = (globalThis.performance as PerformanceWithMemory | undefined)?.memory
    ?.usedJSHeapSize;
  return Number.isFinite(value) && (value ?? -1) >= 0 ? value : undefined;
}

/** Allocation-free UTF-8 byte length, including TextEncoder-compatible surrogate handling. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Tracks currently retained payloads and samples real browser heap when supported. */
export class PayloadMemoryMeter {
  private readonly options: PayloadMemoryMeterOptions;
  private activeBytes = 0;
  private peakActiveBytes = 0;
  private processedUnits = 0;
  private peakBrowserHeapBytes = 0;

  constructor(options: PayloadMemoryMeterOptions) {
    if (!Number.isFinite(options.budgetBytes) || options.budgetBytes <= 0) {
      throw new RangeError('Payload memory budget must be finite and greater than zero');
    }
    this.options = options;
  }

  /** Reserves payload bytes until the returned idempotent release function is called. */
  retain(bytes: number, unit: string): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError(`Payload byte length must be a non-negative safe integer, got ${bytes}`);
    }
    const required = this.activeBytes + bytes;
    if (required > this.options.budgetBytes) {
      throw new PayloadMemoryLimitError(
        `${this.options.label} (${unit})`,
        required,
        this.options.budgetBytes,
      );
    }
    this.activeBytes = required;
    this.peakActiveBytes = Math.max(this.peakActiveBytes, this.activeBytes);
    this.processedUnits += 1;
    this.emit(unit);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeBytes -= bytes;
      this.emit(unit);
    };
  }

  snapshot(unit = 'snapshot'): PayloadMemorySample {
    return this.buildSample(unit);
  }

  private emit(unit: string): void {
    this.options.onSample?.(this.buildSample(unit));
  }

  private buildSample(unit: string): PayloadMemorySample {
    const browserHeapBytes = (this.options.readBrowserHeapBytes ?? readBrowserHeapBytes)();
    if (browserHeapBytes !== undefined) {
      this.peakBrowserHeapBytes = Math.max(this.peakBrowserHeapBytes, browserHeapBytes);
    }
    return {
      label: this.options.label,
      unit,
      activeBytes: this.activeBytes,
      peakActiveBytes: this.peakActiveBytes,
      processedUnits: this.processedUnits,
      ...(browserHeapBytes === undefined ? {} : { browserHeapBytes }),
      ...(this.peakBrowserHeapBytes === 0
        ? {}
        : { peakBrowserHeapBytes: this.peakBrowserHeapBytes }),
    };
  }
}

/**
 * Audio encoder registry: the seam between the mixdown renderer and concrete
 * file encoders. WAV ships built in; compressed-format encoders (small
 * pure-JS/wasm implementations only — every asset must stay same-origin and
 * under the deployment size limits) register themselves through
 * {@link registerEncoder}.
 */

import { type EncodeWavOptions, encodeWav, type WavBitDepth } from './wav';

/** Open option bag passed through to an encoder (encoder-specific keys). */
export type AudioEncodeOptions = Record<string, unknown>;

/** One registered audio file encoder. */
export interface AudioEncoder {
  /** Stable registry id (e.g. 'wav'). */
  readonly id: string;
  /** Human-readable label for format pickers. */
  readonly label: string;
  /** File extension including the dot (e.g. '.wav'). */
  readonly extension: string;
  /** MIME type of the produced file. */
  readonly mime: string;
  /**
   * True when identical PCM/options should produce byte-identical output.
   * Browser/platform codecs may set false because the implementation is
   * runtime-dependent.
   */
  readonly deterministic?: boolean;
  /**
   * Encodes planar audio buffers into a complete file. May be async (worker
   * or wasm-backed encoders).
   */
  encode(
    channels: ReadonlyArray<Float32Array>,
    sampleRate: number,
    options?: AudioEncodeOptions,
  ): Uint8Array | Promise<Uint8Array>;
}

/** Registry id of the built-in WAV encoder. */
export const WAV_ENCODER_ID = 'wav';

const encoders = new Map<string, AudioEncoder>();

/**
 * Registers an encoder under its id.
 *
 * @param encoder Encoder to register.
 * @throws RangeError when the id is empty or already registered.
 */
export function registerEncoder(encoder: AudioEncoder): void {
  if (typeof encoder.id !== 'string' || encoder.id.length === 0) {
    throw new RangeError('Audio encoder id must not be empty');
  }
  if (encoders.has(encoder.id)) {
    throw new RangeError(`Audio encoder id already registered: ${encoder.id}`);
  }
  encoders.set(encoder.id, encoder);
}

/** Lists the registered encoders in registration order. */
export function listEncoders(): AudioEncoder[] {
  return [...encoders.values()];
}

/**
 * Returns the encoder registered under an id.
 *
 * @param id Encoder registry id.
 * @throws RangeError when no encoder is registered under the id.
 */
export function getEncoder(id: string): AudioEncoder {
  const encoder = encoders.get(id);
  if (!encoder) throw new RangeError(`Unknown audio encoder id: ${id}`);
  return encoder;
}

/** Narrows the open option bag to the WAV encoder options. */
function toWavOptions(options: AudioEncodeOptions = {}): EncodeWavOptions {
  const out: EncodeWavOptions = {};
  const bitDepth = options['bitDepth'];
  if (bitDepth === 16 || bitDepth === 24 || bitDepth === '32f') {
    out.bitDepth = bitDepth as WavBitDepth;
  }
  if (typeof options['dither'] === 'boolean') out.dither = options['dither'];
  if (typeof options['random'] === 'function') out.random = options['random'] as () => number;
  return out;
}

registerEncoder({
  id: WAV_ENCODER_ID,
  label: 'WAV (PCM)',
  extension: '.wav',
  mime: 'audio/wav',
  deterministic: true,
  encode: (channels, sampleRate, options) => encodeWav(channels, sampleRate, toWavOptions(options)),
});

/** Channel-layout helpers shared by the analysers that only take one channel. */

/**
 * Downmixes planar channels to a single mono Float32Array (channel average).
 * The output spans the first channel; shorter channels contribute only the
 * frames they have. A mono input is returned as-is unless `copy` is set. An
 * empty input yields an empty buffer.
 *
 * @param channels Planar channel buffers (equal length expected).
 * @param options.copy Return a fresh buffer for mono input, for callers that
 *   transfer or mutate the result.
 * @returns The mono mixdown.
 */
export function downmixToMono(
  channels: ReadonlyArray<Float32Array>,
  options: { copy?: boolean } = {},
): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return options.copy ? new Float32Array(channels[0]) : channels[0];
  const frames = channels[0].length;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    const n = Math.min(frames, channel.length);
    for (let i = 0; i < n; i++) out[i] += channel[i];
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < frames; i++) out[i] *= inv;
  return out;
}

/** Channel-layout helpers shared by the analysers that only take one channel. */

/**
 * Downmixes planar channels to a single mono Float32Array (channel average).
 * A mono input is returned as-is (callers only read it). An empty input yields
 * an empty buffer.
 *
 * @param channels Planar channel buffers (equal length expected).
 * @returns The mono mixdown.
 */
export function downmixToMono(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
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

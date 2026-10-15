/**
 * Validates planar encoder input: a bounded channel count and equal-length
 * buffers.
 *
 * @param channels Planar channel buffers.
 * @param label Encoder name used in error messages (for example `WAV`).
 * @param maxChannels Highest accepted channel count; unbounded when omitted.
 * @returns The frame count shared by every channel.
 * @throws RangeError on an unsupported channel count or mismatched lengths.
 */
export function assertPlanarChannels(
  channels: ReadonlyArray<Float32Array>,
  label: string,
  maxChannels = Number.POSITIVE_INFINITY,
): number {
  if (channels.length < 1 || channels.length > maxChannels) {
    throw new RangeError(
      Number.isFinite(maxChannels)
        ? `${label} encoding supports 1 to ${maxChannels} channels, got ${channels.length}`
        : `${label} encoding requires at least one channel`,
    );
  }
  const frames = channels[0].length;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError(`${label} channel buffers must have equal lengths`);
  }
  return frames;
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Read the file delivered by the browser, including completion failures. */
export async function downloadBytes(download) {
  const failure = await download.failure();
  if (failure) throw new Error(`Download failed: ${failure}`);
  const path = await download.path();
  if (!path) throw new Error(`No file for download ${download.suggestedFilename()}`);
  return readFile(path);
}

/** Inspect actual exported PCM; hashes exclude container metadata. */
export function inspectWav(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (
    bytes.length < 12 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new Error('Invalid or truncated RIFF/WAVE download');
  }
  let fmt;
  let data;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new Error(`Truncated WAV ${name} chunk`);
    if (name === 'fmt ') fmt = bytes.subarray(offset + 8, end);
    if (name === 'data') data = bytes.subarray(offset + 8, end);
    offset = end + (length % 2);
  }
  if (!fmt || fmt.length < 16 || !data) throw new Error('WAV lacks fmt or data');
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bitsPerSample = fmt.readUInt16LE(14);
  const bytesPerSample = bitsPerSample / 8;
  if (
    channels < 1 ||
    sampleRate < 1 ||
    blockAlign !== channels * bytesPerSample ||
    data.length % blockAlign !== 0 ||
    !(
      (format === 1 && [16, 24, 32].includes(bitsPerSample)) ||
      (format === 3 && bitsPerSample === 32)
    )
  ) {
    throw new Error(
      `Unsupported WAV layout ${JSON.stringify({ format, channels, bitsPerSample })}`,
    );
  }
  const frames = data.length / blockAlign;
  const samples = new Float32Array(frames * channels);
  const channelEnergy = Array(channels).fill(0);
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const offset = index * bytesPerSample;
    const sample =
      format === 3
        ? data.readFloatLE(offset)
        : data.readIntLE(offset, bytesPerSample) / 2 ** (bitsPerSample - 1);
    if (!Number.isFinite(sample)) throw new Error(`Non-finite exported sample ${index}`);
    samples[index] = sample;
    peak = Math.max(peak, Math.abs(sample));
    channelEnergy[index % channels] += sample * sample;
  }
  return {
    samples,
    format,
    channels,
    sampleRate,
    bitsPerSample,
    frames,
    durationSeconds: frames / sampleRate,
    peak,
    rms: frames
      ? Math.sqrt(channelEnergy.reduce((sum, energy) => sum + energy, 0) / samples.length)
      : 0,
    channelRms: channelEnergy.map((energy) => (frames ? Math.sqrt(energy / frames) : 0)),
    pcmHash: createHash('sha256').update(data).digest('hex'),
  };
}

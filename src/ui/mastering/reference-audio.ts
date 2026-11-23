import { useI18n } from '@/ui/i18n';

/** Decoded audio used as a mastering-reference comparison target. */
export interface MasteringReferenceAudio {
  name: string;
  channels: Float32Array[];
  sampleRate: number;
}

/** Browser boundary for decoding a user-supplied mastering reference. */
export async function decodeMasteringReference(file: File): Promise<MasteringReferenceAudio> {
  const { t } = useI18n();
  const copy = t.value.shell.mastering.reference;
  const OfflineCtx = globalThis.OfflineAudioContext;
  if (typeof OfflineCtx !== 'function') throw new Error(copy.decodeUnavailable);
  const context = new OfflineCtx(2, 1, 48000);
  const decoded = await context.decodeAudioData((await file.arrayBuffer()).slice(0));
  if (decoded.numberOfChannels < 1 || decoded.length < 1 || !(decoded.sampleRate > 0)) {
    throw new RangeError(copy.emptyAudio);
  }
  const channels = Array.from(
    { length: decoded.numberOfChannels },
    (_unused, index) => new Float32Array(decoded.getChannelData(index)),
  );
  return { name: file.name || copy.untitled, channels, sampleRate: decoded.sampleRate };
}

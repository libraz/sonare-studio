/** One-shot worker for deterministic audio codecs used by the export dialog. */

import { WAV_ENCODER_ID } from '@/export/codecs';
import { type EncodeFlacOptions, encodeFlac, FLAC_ENCODER_ID } from '@/export/flac';
import { type EncodeMp3Options, encodeMp3, MP3_ENCODER_ID } from '@/export/mp3';
import { type EncodeWavOptions, encodeWav } from '@/export/wav';

export type WorkerAudioEncoderId =
  | typeof WAV_ENCODER_ID
  | typeof FLAC_ENCODER_ID
  | typeof MP3_ENCODER_ID;

export interface AudioEncodeWorkerRequest {
  type: 'encode';
  encoderId: WorkerAudioEncoderId;
  channels: Float32Array[];
  sampleRate: number;
  options: Record<string, unknown>;
}

export type AudioEncodeWorkerResponse =
  | { type: 'encoded'; bytes: Uint8Array }
  | { type: 'error'; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<AudioEncodeWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'encode') return;
  void (async () => {
    try {
      let bytes: Uint8Array;
      if (request.encoderId === WAV_ENCODER_ID) {
        bytes = encodeWav(
          request.channels,
          request.sampleRate,
          request.options as EncodeWavOptions,
        );
      } else if (request.encoderId === FLAC_ENCODER_ID) {
        bytes = encodeFlac(
          request.channels,
          request.sampleRate,
          request.options as EncodeFlacOptions,
        );
      } else if (request.encoderId === MP3_ENCODER_ID) {
        bytes = await encodeMp3(
          request.channels,
          request.sampleRate,
          request.options as EncodeMp3Options,
        );
      } else {
        throw new RangeError(`Unsupported worker audio encoder: ${String(request.encoderId)}`);
      }
      const response: AudioEncodeWorkerResponse = { type: 'encoded', bytes };
      scope.postMessage(response, [bytes.buffer]);
    } catch (error) {
      const response: AudioEncodeWorkerResponse = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    }
  })();
});

/** One-shot worker for deterministic audio codecs used by the export dialog. */

import { WAV_ENCODER_ID } from '@/export/codecs';
import { type EncodeFlacOptions, encodeFlac, FLAC_ENCODER_ID } from '@/export/flac';
import { type EncodeMp3Options, encodeMp3, MP3_ENCODER_ID } from '@/export/mp3';
import { type EncodeWavOptions, encodeWav } from '@/export/wav';
import { errorMessage } from '@/lib/errors';
import { isFiniteNumber } from '@/lib/math';
import { isChannelList, isRecord, serveWorkerRequests } from './worker-request';

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
  | { type: 'progress'; fraction: number }
  | { type: 'error'; error: string };

function validRequest(value: unknown): value is AudioEncodeWorkerRequest {
  return (
    isRecord(value) &&
    value.type === 'encode' &&
    (value.encoderId === WAV_ENCODER_ID ||
      value.encoderId === FLAC_ENCODER_ID ||
      value.encoderId === MP3_ENCODER_ID) &&
    isChannelList(value.channels) &&
    isFiniteNumber(value.sampleRate) &&
    value.sampleRate > 0 &&
    isRecord(value.options)
  );
}

serveWorkerRequests<AudioEncodeWorkerRequest, AudioEncodeWorkerResponse>({
  validate: validRequest,
  invalidMessage: 'Audio encode worker received an invalid request',
  errorReply: (error) => ({ type: 'error', error: errorMessage(error) }),
  handle: async (request, post) => {
    let bytes: Uint8Array;
    if (request.encoderId === WAV_ENCODER_ID) {
      bytes = encodeWav(request.channels, request.sampleRate, request.options as EncodeWavOptions);
    } else if (request.encoderId === FLAC_ENCODER_ID) {
      bytes = encodeFlac(
        request.channels,
        request.sampleRate,
        request.options as EncodeFlacOptions,
        (fraction) => post({ type: 'progress', fraction }),
      );
    } else {
      bytes = await encodeMp3(
        request.channels,
        request.sampleRate,
        request.options as EncodeMp3Options,
      );
    }
    post({ type: 'encoded', bytes }, [bytes.buffer as ArrayBuffer]);
  },
});

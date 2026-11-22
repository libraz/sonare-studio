/** What a DAWproject import could not carry over, and the dialog report built from it. */

import { type LossReport, LossTally } from '@/export/loss-descriptor';

export interface DawprojectMediaIssue {
  path: string;
  external: boolean;
  reason: 'missing' | 'resolve-failed' | 'ingest-failed';
  message?: string;
}

/** A DAWproject value that could not be interpreted without a lossy fallback. */
export type DawprojectImportLoss =
  | {
      kind: 'unsupported-time-unit';
      clipName: string;
      attribute: 'contentTimeUnit' | 'fadeTimeUnit' | 'timeUnit';
      unit: string;
    }
  | {
      kind: 'unsupported-warp';
      clipName: string;
      reason: 'time-units' | 'insufficient-points' | 'non-monotonic';
      timeUnit?: string;
      contentTimeUnit?: string;
    }
  | {
      kind: 'unsupported-nested-clip';
      clipName: string;
      reason:
        | 'mixed-time-units'
        | 'loop-with-multiple-events'
        | 'missing-content'
        | 'loop-start-offset';
    }
  | {
      /** Sonare has no disabled-clip model, so disabled content is skipped. */
      kind: 'disabled-clip';
      clipName: string;
    }
  | {
      /** A non-empty MIDI expression lane could not be interpreted. */
      kind: 'unsupported-midi-expression';
      clipName: string;
      expression: string;
      reason:
        | 'missing-target'
        | 'unknown-expression'
        | 'missing-channel'
        | 'invalid-channel'
        | 'missing-controller'
        | 'invalid-controller'
        | 'missing-key'
        | 'invalid-key'
        | 'unsupported-point-type'
        | 'malformed-point'
        /** A timeline-level expression cannot be attached to an audio/group track. */
        | 'non-midi-track'
        /** A timeline-level expression did not identify the Structure track it targets. */
        | 'missing-track';
    }
  | {
      /** A plugin or non-Sonare device; its state cannot be reproduced. */
      kind: 'foreign-device';
      trackName: string;
      device: string;
    }
  | {
      /** Parameter automation whose target has no Sonare parameter. */
      kind: 'unmapped-automation';
      trackName: string;
      parameter: string;
    }
  | {
      /** A send whose destination is not an effect channel Sonare imports as a bus. */
      kind: 'unmapped-send';
      trackName: string;
      destination: string;
    }
  | {
      /** An arrangement lane addressing no imported track. */
      kind: 'orphan-lane';
      track: string;
    };

/** Every class the DAWproject import loss dialog can list, in dialog order. */
export const DAWPROJECT_IMPORT_LOSS_KINDS = [
  'missing-media',
  'unreadable-media',
  'foreign-device',
  'unmapped-automation',
  'unmapped-send',
  'orphan-lane',
  'unsupported-time-unit',
  'unsupported-warp',
  'unsupported-nested-clip',
  'disabled-clip',
  'unsupported-midi-expression',
] as const satisfies ReadonlyArray<
  DawprojectImportLoss['kind'] | 'missing-media' | 'unreadable-media'
>;

export type DawprojectImportLossKind = (typeof DAWPROJECT_IMPORT_LOSS_KINDS)[number];

function lossDetail(loss: DawprojectImportLoss): string {
  switch (loss.kind) {
    case 'unsupported-time-unit':
      return `${loss.clipName}: ${loss.attribute}=${loss.unit}`;
    case 'unsupported-warp':
    case 'unsupported-nested-clip':
      return `${loss.clipName}: ${loss.reason}`;
    case 'disabled-clip':
      return loss.clipName;
    case 'unsupported-midi-expression':
      return `${loss.clipName}: ${loss.expression}`;
    case 'foreign-device':
      return `${loss.trackName}: ${loss.device}`;
    case 'unmapped-automation':
      return `${loss.trackName}: ${loss.parameter}`;
    case 'unmapped-send':
      return `${loss.trackName}: ${loss.destination}`;
    case 'orphan-lane':
      return loss.track;
  }
}

/** Combines media issues and parser losses into the dialog report. */
export function dawprojectImportLossReport(
  losses: ReadonlyArray<DawprojectImportLoss>,
  mediaIssues: ReadonlyArray<DawprojectMediaIssue>,
): LossReport<DawprojectImportLossKind> {
  const tally = new LossTally(DAWPROJECT_IMPORT_LOSS_KINDS);
  for (const issue of mediaIssues) {
    tally.add(issue.reason === 'missing' ? 'missing-media' : 'unreadable-media', 1, issue.path);
  }
  for (const loss of losses) tally.add(loss.kind, 1, lossDetail(loss));
  return tally.report();
}

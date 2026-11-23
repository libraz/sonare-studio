import { describe, expect, it } from 'vitest';
import { clampClipFadePpq, validateClipFadePair } from '@/project/clip-fades';
import { clipSplitBlockReason, LOOP_CLIP_SPLIT_ERROR } from '@/project/clip-split';
import { withDerivedClipMetadata } from '@/project/command/utils';
import { canonicalJson, fnv1a32Hex } from '@/project/hash';
import {
  createMediaCompletenessReport,
  formatMediaCompletenessReport,
  mediaFailureIssues,
  projectMediaReferences,
} from '@/project/media-completeness';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { applyDocumentClipMetadata } from '@/project/store-load';
import { buildClipMirror, buildTrackMirror, refreshTempoMeter } from '@/project/store-refresh';
import type { EditorClip } from '@/project/types';
import { MESSAGES } from '@/ui/i18n';
import { documentClip } from './fakes/project';

function projectFixture(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Media audit',
    sampleRate: 48_000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Audio',
        color: '#fff',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        frozen: { assetId: 'frozen-audio' },
        clips: [
          documentClip({
            name: 'Take',
            kind: 'audio',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            assetId: 'clip-audio',
            takes: [{ assetId: 'take-audio', name: 'Take 1' }],
            notes: [],
          }),
        ],
      },
      {
        name: 'Instrument',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'sf2', fontId: 'font-audio', program: 0 },
        clips: [],
      },
    ],
    markers: [],
    sections: [],
  };
}

function clip(): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Before load',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
  };
}

describe('project utility boundaries', () => {
  it('keeps fades within the clip window and rejects overlapping envelopes', () => {
    expect(clampClipFadePpq(9, 8, 3)).toBe(5);
    expect(clampClipFadePpq(Number.NaN, 8, 0)).toBe(0);
    expect(() => validateClipFadePair(4, 4, 8)).not.toThrow();
    expect(() => validateClipFadePair(4.1, 4, 8)).toThrow(/must not exceed/);
  });

  it('uses one split eligibility contract for looped and boundary positions', () => {
    expect(LOOP_CLIP_SPLIT_ERROR).toMatch(/Turn Loop off/);
    expect(clipSplitBlockReason({ startPpq: 2, lengthPpq: 4, loopEnabled: true }, 4)).toBe('loop');
    expect(clipSplitBlockReason({ startPpq: 2, lengthPpq: 4 }, 2)).toBe('position');
    expect(clipSplitBlockReason({ startPpq: 2, lengthPpq: 4 }, 4)).toBeNull();
  });

  it('canonicalizes object ordering before producing cache hashes', () => {
    expect(canonicalJson({ b: 2, a: { z: true, a: undefined } })).toBe('{"a":{"z":true},"b":2}');
    expect(fnv1a32Hex(canonicalJson({ a: 1, b: 2 }))).toBe(
      fnv1a32Hex(canonicalJson({ b: 2, a: 1 })),
    );
  });

  it('reports every concrete media reference once and retains actionable locations', () => {
    const doc = projectFixture();
    expect(projectMediaReferences(doc, 'audio-asset', 'take-audio')).toEqual([
      {
        kind: 'audio-asset',
        mediaId: 'take-audio',
        role: 'take',
        projectName: 'Media audit',
        trackId: 1,
        clipId: 1,
      },
    ]);
    const issues = mediaFailureIssues(
      doc,
      'audio-asset',
      'clip-audio',
      'unreadable',
      Error('gone'),
    );
    const report = createMediaCompletenessReport([...issues, ...issues]);
    expect(report).toMatchObject({ complete: false });
    expect(report.issues).toHaveLength(1);
    expect(
      formatMediaCompletenessReport(report, MESSAGES.en.shell.project.mediaCompleteness.report),
    ).toContain('project “Media audit”, track 1, clip 1');
    expect(mediaFailureIssues(doc, 'soundfont', 'unknown', 'missing')[0]).toMatchObject({
      role: 'library',
      projectName: 'Media audit',
    });
  });
});

describe('project store mirror boundaries', () => {
  it('retains group semantics and display order when refreshing native tracks', () => {
    const previous = [
      {
        id: 10,
        name: 'Group',
        color: '#fff',
        kind: 'group' as const,
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 8,
      },
    ];
    const result = buildTrackMirror(
      {
        tracks: [
          { id: 10, kind: 'aux', name: 'Renamed' },
          { id: 11, kind: 'audio', name: 'Audio' },
        ],
      },
      previous,
    );
    expect(result.tracks.map((track) => [track.id, track.kind, track.order])).toEqual([
      [10, 'group', 0],
      [11, 'audio', 1],
    ]);
    expect(result.tracks[0].name).toBe('Renamed');
    expect(result.trackOrder.get(11)).toBe(1);
  });

  it('keeps a valid tempo/meter mirror and rejects an invalid primary tempo', () => {
    expect(
      refreshTempoMeter({
        tempoSegments: [
          { startPpq: 0, bpm: 0 },
          { startPpq: 4, bpm: 140, endBpm: 160 },
        ],
        timeSignatures: [{ startPpq: 4, numerator: 3, denominator: 4 }],
      }),
    ).toEqual({
      tempoSegments: [
        { startPpq: 0, bpm: 0 },
        { startPpq: 4, bpm: 140, endBpm: 160 },
      ],
      tempoBpm: null,
      timeSignatures: [{ startPpq: 4, numerator: 3, denominator: 4 }],
    });
  });

  it('hydrates audio-only document metadata while sanitizing malformed takes and comp segments', () => {
    const metadata = {
      name: 'Loaded audio',
      kind: 'audio',
      assetId: 'asset-1',
      fadeInPpq: 1,
      fadeOutPpq: 2,
      takes: [
        { assetId: 'take-1', name: 'Main' },
        { assetId: '', name: 'Invalid' },
      ],
      compSegments: [
        { startPpq: 0, takeIndex: 0, crossfadePpq: 0.5 },
        { startPpq: 3, takeIndex: 9 },
      ],
    } as DocumentClip;
    const [loaded] = applyDocumentClipMetadata([clip()], new Map([[1, metadata]]));

    expect(loaded).toMatchObject({
      name: 'Loaded audio',
      kind: 'audio',
      assetId: 'asset-1',
      fadeInPpq: 1,
      fadeOutPpq: 2,
      takes: [{ assetId: 'take-1', name: 'Main' }],
      compSegments: [{ startPpq: 0, takeIndex: 0, crossfadePpq: 0.5 }],
    });
  });

  it('retains opaque SMF SysEx through refresh and transforms it for a derived window', () => {
    const previous = [
      {
        ...clip(),
        smfSysEx: [
          { ppq: 1, status: 0xf0 as const, data: [0x41, 0x10] },
          { ppq: 2.5, status: 0xf7 as const, data: [0x7e, 0x7f] },
        ],
      },
    ];
    const [refreshed] = buildClipMirror(
      {
        tracks: [{ id: 1, kind: 'midi', name: 'MIDI' }],
        clips: [
          {
            id: 1,
            trackId: 1,
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopMode: 'off',
            loopLengthPpq: 0,
          },
        ],
      },
      previous,
      new Map([[1, 0]]),
      -1,
      undefined,
      () => 1,
    );
    expect(refreshed.smfSysEx).toEqual(previous[0].smfSysEx);
    expect(refreshed.smfSysEx?.[0].data).not.toBe(previous[0].smfSysEx?.[0].data);

    const derived = withDerivedClipMetadata(
      { ...clip(), lengthPpq: 1, sourceOffsetPpq: 2 },
      refreshed,
      { windowStartPpq: 2, windowLengthPpq: 1 },
    );
    expect(derived.smfSysEx).toEqual([{ ppq: 0.5, status: 0xf7, data: [0x7e, 0x7f] }]);
    expect(derived.smfSysEx?.[0].data).not.toBe(refreshed.smfSysEx?.[1].data);
  });
});

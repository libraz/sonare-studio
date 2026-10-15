import { describe, expect, it, vi } from 'vitest';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { inspectAudioExportLoss } from '@/export/audio-metadata-loss';
import { WAV_ENCODER_ID } from '@/export/codecs';
import { inspectDawprojectExportLoss } from '@/export/dawproject/export-loss';
import { FLAC_ENCODER_ID } from '@/export/flac';
import { formatLossItems, LossTally } from '@/export/loss-descriptor';
import { MP3_ENCODER_ID } from '@/export/mp3';
import { inspectMidi2ClipExportLoss } from '@/project/midi2-export-loss';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';

function clip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'Phrase',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'midi',
    notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
    ...overrides,
  };
}

function track(overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'Keys',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [clip()],
    ...overrides,
  };
}

function doc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Loss',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [track()],
    markers: [],
    sections: [],
    ...overrides,
  };
}

const kinds = (report: { entries: ReadonlyArray<{ kind: string }> }) =>
  report.entries.map((entry) => entry.kind);

describe('loss descriptor', () => {
  it('orders entries by the format kind order and formats one line per entry', () => {
    const tally = new LossTally(['a', 'b'] as const);
    tally.add('b', 2);
    tally.add('a', 1, 'x');
    tally.add('a', 0, 'ignored');
    const report = tally.report();
    expect(report.entries).toEqual([
      { kind: 'a', count: 1, details: ['x'] },
      { kind: 'b', count: 2, details: [] },
    ]);
    expect(formatLossItems(report, { a: '{count} a ({details})', b: '{count} b' })).toEqual([
      '1 a (x)',
      '2 b',
    ]);
  });

  it('confirms an empty report without asking and lists every entry otherwise', async () => {
    const confirm = vi.fn(async () => false);
    const copy = {
      title: 'T',
      message: 'Omit:\n{items}',
      confirm: 'Go',
      items: { a: '{count} a' },
    };
    await expect(confirmLossReport({ entries: [] }, copy, confirm)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    await expect(
      confirmLossReport({ entries: [{ kind: 'a', count: 3, details: [] }] }, copy, confirm),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith('Omit:\n• 3 a', { title: 'T', confirmLabel: 'Go' });
  });
});

describe('DAWproject export loss', () => {
  it('reports nothing for state project.xml or the Sonare sidecar carries', () => {
    const report = inspectDawprojectExportLoss(
      doc({
        pickupLengthPpq: 1,
        sections: [{ name: 'Verse', color: '#123456', startPpq: 0, endPpq: 4 }],
        chords: [{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }],
        tracks: [
          track({
            clips: [
              clip({
                smfSysEx: [{ ppq: 0, status: 0xf0, data: [0x7e, 0xf7] }],
                ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 0, value: 1 }] }],
              }),
              clip({
                kind: 'audio',
                assetId: 'a',
                notes: [],
                warp: { enabled: true, sourceBpm: 90 },
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.entries).toEqual([]);
  });

  it('reports every per-track and project field neither file carries', () => {
    const report = inspectDawprojectExportLoss(
      doc({
        generationSeed: 0,
        controlSurface: {} as NonNullable<ProjectDocument['controlSurface']>,
        tracks: [
          track({
            percussion: false,
            pitchRange: { low: 40, high: 80 },
            chordFollow: 'root',
            recordInputDeviceId: 'in-1',
            leadFollow: { leadTrackIndex: 1, stash: [] },
            clips: [
              clip({
                fadeInPpq: 1,
                midiCompSegments: [{ startPpq: 0, takeIndex: 0 }],
              }),
              clip({
                kind: 'audio',
                assetId: 'a',
                notes: [],
                warp: { enabled: false, sourceBpm: 90 },
              }),
            ],
          }),
        ],
      }),
    );
    expect(kinds(report)).toEqual([
      'warpedAudioClips',
      'midiClipFades',
      'midiCompSegments',
      'percussionOverrides',
      'chordFollow',
      'leadFollow',
      'pitchRanges',
      'generationSeed',
      'controlSurface',
      'recordInputDevices',
    ]);
  });
});

describe('MIDI 2.0 clip export loss', () => {
  it('lists mixing, mutes, automation and app-level MIDI data the clip file cannot hold', () => {
    const report = inspectMidi2ClipExportLoss(
      doc({
        markers: [{ ppq: 0, name: 'Intro' }],
        tracks: [
          track({
            mute: true,
            volume: 0.5,
            automation: [{ param: 'pan', enabled: true, points: [{ ppq: 0, value: 0 }] }],
            clips: [clip({ smfSysEx: [{ ppq: 0, status: 0xf0, data: [0xf7] }] })],
          }),
          track({ name: 'Vox', kind: 'audio', clips: [clip({ kind: 'audio', notes: [] })] }),
        ],
      }),
    );
    expect(kinds(report)).toEqual([
      'nonMidiTracks',
      'mutedTracks',
      'trackMixLevels',
      'sysExPackets',
      'automationLanes',
      'markers',
    ]);
  });
});

describe('audio export metadata loss', () => {
  const metadata = { title: 'Song', markers: [{ sampleOffset: 0, name: 'Intro' }] };

  it('lists markers once with every format that cannot store them', () => {
    const report = inspectAudioExportLoss(metadata, [
      { id: WAV_ENCODER_ID, label: 'WAV' },
      { id: FLAC_ENCODER_ID, label: 'FLAC' },
      { id: MP3_ENCODER_ID, label: 'MP3' },
      { id: 'opus-ogg', label: 'Opus' },
    ]);
    expect(report.entries).toEqual([{ kind: 'markers', count: 1, details: ['FLAC, MP3, Opus'] }]);
  });

  it('reports nothing when the format writes cue points or there are no markers', () => {
    expect(
      inspectAudioExportLoss(metadata, [{ id: WAV_ENCODER_ID, label: 'WAV' }]).entries,
    ).toEqual([]);
    expect(
      inspectAudioExportLoss({ markers: [] }, [{ id: FLAC_ENCODER_ID, label: 'FLAC' }]).entries,
    ).toEqual([]);
  });
});

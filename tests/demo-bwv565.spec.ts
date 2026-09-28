import { NATURAL_MINOR_MASK } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@/project/serialization';

describe('makeBwv565Document', () => {
  it('builds a four-voice organ document with the curated playback tempo map', async () => {
    const doc = await makeBwv565Document();
    expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(doc.name).toContain('BWV 565');
    expect(doc.tracks).toHaveLength(4);
    expect(doc.tempoSegments).toEqual([
      { startPpq: 0, bpm: 30 },
      { startPpq: 13, bpm: 80 },
      { startPpq: 68, bpm: 70 },
      { startPpq: 94, bpm: 100 },
      { startPpq: 114, bpm: 50 },
      { startPpq: 128, bpm: 90 },
      { startPpq: 511.5, bpm: 30 },
      { startPpq: 516, bpm: 70 },
      { startPpq: 532, bpm: 50 },
      { startPpq: 539, bpm: 80 },
      { startPpq: 566, bpm: 60 },
      { startPpq: 574, bpm: 40 },
    ]);
    expect(doc.scaleHighlight).toEqual({
      enabled: true,
      rootPc: 2,
      modeMask: NATURAL_MINOR_MASK,
    });
    expect(doc.score).toEqual({ fullScoreEnabled: true, displayQuantizeKey: '64' });
    expect(doc.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });

    doc.tracks.forEach((track, index) => {
      expect(track.kind).toBe('midi');
      expect(track.instrument).toEqual({ kind: 'synth-preset', preset: 'church-organ' });
      expect(track.clips).toHaveLength(1);
      const clip = track.clips[0];
      expect(clip.startPpq).toBe(0);
      expect(clip.notes.length).toBeGreaterThan(0);
      for (const note of clip.notes) {
        expect(note.channel).toBe(index);
        expect(note.pitch).toBeGreaterThanOrEqual(0);
        expect(note.pitch).toBeLessThanOrEqual(127);
        expect(note.velocity).toBeGreaterThanOrEqual(1);
        expect(note.velocity).toBeLessThanOrEqual(127);
        expect(note.durationPpq).toBeGreaterThan(0);
        expect(note.startPpq + note.durationPpq).toBeLessThanOrEqual(clip.lengthPpq);
      }
    });
  });

  it('is JSON-able and fresh per call', async () => {
    const doc = await makeBwv565Document();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    const second = await makeBwv565Document();
    expect(second).not.toBe(doc);
    expect(second.tempoSegments).not.toBe(doc.tempoSegments);
    doc.tempoSegments[0].bpm = 999;
    expect(second.tempoSegments[0].bpm).toBe(30);
  });
});

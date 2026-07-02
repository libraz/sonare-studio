import { describe, expect, it } from 'vitest';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@/project/serialization';

describe('makeBwv565Document', () => {
  it('builds a four-voice organ document with the full tempo map', async () => {
    const doc = await makeBwv565Document();
    expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(doc.name).toContain('BWV 565');
    expect(doc.tracks).toHaveLength(4);
    expect(doc.tempoSegments.length).toBeGreaterThan(1);
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
    expect(await makeBwv565Document()).not.toBe(doc);
  });
});

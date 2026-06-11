import { describe, expect, it } from 'vitest';
import { makeDemoNotes } from '@/engine/instruments';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@/project/serialization';
import { createTemplate, makeDemoDocument, TEMPLATE_NAMES } from '@/project/templates';

describe('project templates', () => {
  it('exposes the five built-in template names', () => {
    expect(TEMPLATE_NAMES).toEqual([
      'empty',
      'band',
      'gm-orchestra',
      'programming',
      'transcription',
    ]);
  });

  it('every template is a JSON-able document with the shared skeleton', () => {
    for (const name of TEMPLATE_NAMES) {
      const doc = createTemplate(name);
      expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      expect(doc.sampleRate).toBe(48000);
      expect(doc.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
      expect(doc.timeSignatures).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
      expect(doc.markers).toEqual([]);
      expect(doc.sections).toEqual([]);
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    }
  });

  it('non-empty templates give every MIDI track one empty 8-bar clip', () => {
    for (const name of TEMPLATE_NAMES) {
      const doc = createTemplate(name);
      for (const track of doc.tracks) {
        expect(track.kind).toBe('midi');
        expect(track).toMatchObject({ mute: false, solo: false, volume: 1, pan: 0 });
        expect(track.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(track.clips).toHaveLength(1);
        expect(track.clips[0]).toMatchObject({
          startPpq: 0,
          lengthPpq: 32,
          gain: 1,
          loopEnabled: false,
          notes: [],
        });
      }
    }
  });

  it('the empty template has no tracks at all', () => {
    expect(createTemplate('empty').tracks).toEqual([]);
  });

  it('the band template carries the five standard band tracks', () => {
    const doc = createTemplate('band');
    expect(doc.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Piano', 'Guitar', 'Vocal']);
    expect(new Set(doc.tracks.map((t) => t.color)).size).toBe(doc.tracks.length);
  });

  it('the gm-orchestra template covers strings, woodwinds, brass and percussion', () => {
    const names = createTemplate('gm-orchestra').tracks.map((t) => t.name);
    expect(names).toContain('Violins I'); // strings
    expect(names).toContain('Flutes'); // woodwinds
    expect(names).toContain('Trumpets'); // brass
    expect(names).toContain('Timpani'); // percussion
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('the programming template carries synth-oriented tracks', () => {
    const names = createTemplate('programming').tracks.map((t) => t.name);
    expect(names).toContain('Lead Synth');
    expect(names).toContain('Synth Bass');
    expect(names).toContain('Drums');
  });

  it('the transcription template is a single piano track', () => {
    const doc = createTemplate('transcription');
    expect(doc.tracks.map((t) => t.name)).toEqual(['Piano']);
  });

  it('returns fresh documents on every call', () => {
    const a = createTemplate('band');
    const b = createTemplate('band');
    expect(a).not.toBe(b);
    a.tracks[0].name = 'Changed';
    a.tracks[0].clips[0].notes.push({
      pitch: 60,
      velocity: 96,
      startPpq: 0,
      durationPpq: 1,
      channel: 0,
    });
    expect(b.tracks[0].name).toBe('Drums');
    expect(b.tracks[0].clips[0].notes).toEqual([]);
  });
});

describe('makeDemoDocument', () => {
  it('reproduces the first-run content: one Piano track with the demo arpeggio', () => {
    const doc = makeDemoDocument();
    expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].name).toBe('Piano');
    expect(doc.tracks[0].clips).toHaveLength(1);

    const demo = makeDemoNotes();
    const notes = doc.tracks[0].clips[0].notes;
    expect(notes).toHaveLength(demo.length);
    notes.forEach((note, index) => {
      expect(note).toEqual({
        pitch: demo[index].note,
        velocity: demo[index].velocity,
        startPpq: demo[index].startPpq,
        durationPpq: demo[index].durationPpq,
        channel: demo[index].channel ?? 0,
      });
    });
  });

  it('is JSON-able and fresh per call', () => {
    const doc = makeDemoDocument();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(makeDemoDocument()).not.toBe(doc);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const editor = read('src/components/piano-roll/PianoRollEditor.vue');
const arrangement = read('src/components/arrangement/ArrangementView.vue');
const shortcuts = read('docs/shortcuts.md');

describe('piano-roll editor wiring', () => {
  it('gives the note lane the same color resolver as the grid', () => {
    expect(editor).toMatch(/<VelocityLane[^>]*:note-color="noteColor"/s);
    expect(editor).toMatch(/<NoteGridCanvas[^>]*:note-color="noteColor"/s);
  });

  it('nudges only audible selected notes', () => {
    expect(editor).toContain(
      'const selected = audibleSourceNotes.value.filter((note) => store.selection.has(note.id));',
    );
  });

  it('snaps, floors and numbers bars on the timeline meter', () => {
    expect(editor).toContain('floorPpq: floorPianoRollPpq,');
    expect(editor).not.toContain('localTimeSignatures.value, ppq');
  });

  it('documents the bracket keys as an editor-scope override of the locator shortcuts', () => {
    expect(shortcuts).toMatch(
      /`\[` \/ `\]` \| Shorten \/ lengthen selected notes[^\n]*editor dock/,
    );
  });
});

describe('arrangement keyboard clip move', () => {
  it('only targets lanes the pointer path can reach', () => {
    const handler = arrangement.slice(arrangement.indexOf('function onClipKeyboardAction'));
    expect(handler).toContain('const lanes = visibleTracks.value;');
    expect(handler.slice(0, handler.indexOf('function glueClusterClipIds'))).not.toContain(
      'store.tracks[',
    );
  });
});

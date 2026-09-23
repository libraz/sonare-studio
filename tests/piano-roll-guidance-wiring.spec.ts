import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const editor = source('src/components/piano-roll/PianoRollEditor.vue');
const toolbar = source('src/components/piano-roll/PianoRollToolbar.vue');
const chordLane = source('src/components/arrangement/ChordLane.vue');

/** The opening tag of the first `<Tag` element in a template, up to its closing `>`. */
function elementTag(text: string, tag: string): string {
  const start = text.indexOf(`<${tag}`);
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('/>', start));
}

describe('piano-roll placement guidance wiring', () => {
  it('derives the placement cell from the hover, the tool and the draw preview', () => {
    expect(editor).toContain('usePlacementCell({');
    expect(editor).toContain('previewNotes: interactions.previewNotes');
    expect(editor).toContain('drawCellAt: interactions.drawCellAt');
  });

  it('evaluates the column through usePlacementGuidance and hands it to the grid', () => {
    expect(editor).toContain('usePlacementGuidance(placementCell)');
    expect(elementTag(editor, 'NoteGridCanvas')).toContain(':placement-column="placementColumn"');
  });

  it('reads the hovered row verdict into the live status cell', () => {
    expect(editor).toContain('describePlacementVerdict(');
    expect(editor).toContain('store.leadFollowDeferred');
    expect(editor).toMatch(/class="cell-status" aria-live="polite"/);
  });

  it('passes the project key map to the piano-roll chord lane', () => {
    const lane = elementTag(editor, 'ChordLane');
    expect(editor).toContain('buildKeyMap(store.scaleHighlight, store.markers)');
    expect(lane).toContain(':key-map="keyMap"');
    expect(lane).not.toContain(':key-fifths');
  });

  it('requires a key map on the chord lane', () => {
    expect(chordLane).toMatch(/\bkeyMap: KeyMap;/);
    expect(chordLane).not.toMatch(/\bkeyFifths\?: number/);
    expect(chordLane).not.toMatch(/\bkeyScale\?: KeyScale/);
  });

  it('binds both guide toggles to their persisted settings', () => {
    expect(editor).toContain("appSettings.set('pianoRollPlacementGuide', value)");
    expect(editor).toContain("appSettings.set('pianoRollGuidanceTint', value)");
    expect(editor).toContain('v-model:placement-guide="placementGuide"');
    expect(editor).toContain('v-model:guidance-tint="guidanceTint"');
    expect(toolbar).toContain('v-model="placementGuide"');
    expect(toolbar).toContain('v-model="guidanceTint"');
  });

  it('labels the toggles and the deferred-follow notice in every locale', () => {
    for (const bundle of [en, ja]) {
      const roll = bundle.shell.pianoRoll;
      expect(roll.placementGuideToggle.length).toBeGreaterThan(0);
      expect(roll.guidanceTintToggle.length).toBeGreaterThan(0);
      expect(roll.placement.leadFollowDeferred.length).toBeGreaterThan(0);
    }
  });
});

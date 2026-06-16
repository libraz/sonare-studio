/**
 * Editor tool model shared by the arrangement and the piano roll.
 *
 * Professional DAWs expose an explicit tool (select / draw / split / erase)
 * that the editing surfaces switch on, in addition to the smart-cursor
 * behavior of the select tool. The active tool lives in a single shared ref
 * (see src/composables/useEditorTool.ts) so the tool palette, the keyboard
 * shortcuts and every editing surface stay in lockstep.
 *
 * Tools that would need engine/model support that does not exist yet (mute,
 * glue) are intentionally omitted rather than shipped as dead controls.
 */

/** The editor tools, in palette/number-key order. */
export const EDITOR_TOOLS = ['select', 'draw', 'split', 'erase'] as const;

/** One editor tool id. */
export type EditorToolId = (typeof EDITOR_TOOLS)[number];

/** Display metadata for one tool. */
export interface EditorToolDef {
  /** Tool id. */
  id: EditorToolId;
  /** Short human label. */
  label: string;
  /** Single-glyph icon for the palette button. */
  glyph: string;
  /** Number key that activates the tool (also shown in the tooltip). */
  key: string;
  /** One-line description for the tooltip/help. */
  hint: string;
}

/** Tool definitions in palette order; the index + 1 is the activation key. */
export const EDITOR_TOOL_DEFS: readonly EditorToolDef[] = [
  {
    id: 'select',
    label: 'Select',
    glyph: '↖',
    key: '1',
    hint: 'Select, move and resize (smart cursor)',
  },
  { id: 'draw', label: 'Draw', glyph: '✎', key: '2', hint: 'Draw clips and notes' },
  { id: 'split', label: 'Split', glyph: '✂', key: '3', hint: 'Split at the click position' },
  { id: 'erase', label: 'Erase', glyph: '⌫', key: '4', hint: 'Delete clips and notes' },
];

/** Resolves the tool a number key selects, or null when the key is unmapped. */
export function toolForKey(key: string): EditorToolId | null {
  return EDITOR_TOOL_DEFS.find((def) => def.key === key)?.id ?? null;
}

/**
 * Shared active-editor-tool state.
 *
 * A single module-level ref backs the tool so the palette, keyboard shortcuts
 * and both editing surfaces (arrangement, piano roll) read and write the same
 * value — switching the tool anywhere updates everywhere, mirroring how a
 * professional DAW shares one tool across the project window and editors.
 */

import { type Ref, readonly, ref } from 'vue';
import { type EditorToolId, toolForKey } from '@/ui/editor/tools';

/** The shared active tool (module-level so every consumer shares it). */
const activeTool = ref<EditorToolId>('select');

/** Public API of {@link useEditorTool}. */
export interface EditorToolApi {
  /** The active tool (read-only; mutate via {@link setTool}). */
  tool: Readonly<Ref<EditorToolId>>;
  /** Switches the active tool. */
  setTool(tool: EditorToolId): void;
  /**
   * Activates the tool bound to a number key.
   *
   * @returns True when the key mapped to a tool (caller should preventDefault).
   */
  selectByKey(key: string): boolean;
}

/** Returns the shared editor-tool API. */
export function useEditorTool(): EditorToolApi {
  return {
    tool: readonly(activeTool),
    setTool(tool: EditorToolId): void {
      activeTool.value = tool;
    },
    selectByKey(key: string): boolean {
      const next = toolForKey(key);
      if (next === null) return false;
      activeTool.value = next;
      return true;
    },
  };
}

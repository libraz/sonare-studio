<script setup lang="ts">
/**
 * Editor tool palette: one toggle button per tool, bound to the shared
 * editor-tool state so it stays in sync with the number-key shortcuts and
 * both editing surfaces. The active tool applies to the arrangement and the
 * piano roll alike.
 */
import { useEditorTool } from '@/composables/useEditorTool';
import { EDITOR_TOOL_DEFS } from '@/ui/editor/tools';

const { tool, setTool } = useEditorTool();
</script>

<template>
  <div class="tool-palette" role="toolbar" aria-label="Editor tools">
    <button
      v-for="def in EDITOR_TOOL_DEFS"
      :key="def.id"
      type="button"
      class="tool-button"
      :class="{ active: tool === def.id }"
      :aria-pressed="tool === def.id"
      :aria-label="`${def.label} tool`"
      :title="`${def.label} (${def.key}) — ${def.hint}`"
      @click="setTool(def.id)"
    >
      <span class="tool-glyph" aria-hidden="true">{{ def.glyph }}</span>
    </button>
  </div>
</template>

<style scoped>
.tool-palette {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-1);
}

.tool-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: var(--fs-md);
  line-height: 1;
  cursor: pointer;
}

.tool-button:hover {
  background: var(--surface-3);
  color: var(--text-1);
}

.tool-button.active {
  background: var(--accent-strong);
  color: var(--text-1);
}

.tool-glyph {
  pointer-events: none;
}
</style>

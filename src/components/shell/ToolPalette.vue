<script setup lang="ts">
/**
 * Editor tool palette: one toggle button per tool, bound to the shared
 * editor-tool state so it stays in sync with the number-key shortcuts and
 * both editing surfaces. The active tool applies to the arrangement and the
 * piano roll alike.
 */
import { useEditorTool } from '@/composables/useEditorTool';
import { EDITOR_TOOL_DEFS } from '@/ui/editor/tools';
import { formatMessage, useI18n } from '@/ui/i18n';

const { tool, setTool } = useEditorTool();
const { t } = useI18n();

type EditorToolId = (typeof EDITOR_TOOL_DEFS)[number]['id'];

function toolName(id: EditorToolId): string {
  return t.value.shell.tools.names[id];
}

function toolHint(id: EditorToolId): string {
  return t.value.shell.tools.hints[id];
}
</script>

<template>
  <div class="tool-palette" role="toolbar" :aria-label="t.shell.tools.label">
    <button
      v-for="def in EDITOR_TOOL_DEFS"
      :key="def.id"
      type="button"
      class="tool-button"
      :class="{ active: tool === def.id }"
      :aria-pressed="tool === def.id"
      :aria-label="formatMessage(t.shell.tools.toolLabel, { name: toolName(def.id) })"
      :title="
        formatMessage(t.shell.tools.toolTitle, {
          name: toolName(def.id),
          key: def.key,
          hint: toolHint(def.id),
        })
      "
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

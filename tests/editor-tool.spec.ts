import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorTool } from '@/composables/useEditorTool';
import { EDITOR_TOOL_DEFS, EDITOR_TOOLS, toolForKey } from '@/ui/editor/tools';

describe('editor tool model', () => {
  it('defines one display entry per tool, in number-key order', () => {
    expect(EDITOR_TOOL_DEFS.map((def) => def.id)).toEqual([...EDITOR_TOOLS]);
    EDITOR_TOOL_DEFS.forEach((def, index) => {
      expect(def.key).toBe(String(index + 1));
    });
  });

  it('maps number keys to tools and rejects unmapped keys', () => {
    expect(toolForKey('1')).toBe('select');
    expect(toolForKey('2')).toBe('draw');
    expect(toolForKey('3')).toBe('split');
    expect(toolForKey('4')).toBe('erase');
    expect(toolForKey('5')).toBeNull();
    expect(toolForKey('a')).toBeNull();
  });
});

describe('useEditorTool', () => {
  beforeEach(() => {
    useEditorTool().setTool('select');
  });

  it('shares one tool value across consumers', () => {
    const a = useEditorTool();
    const b = useEditorTool();
    a.setTool('draw');
    expect(b.tool.value).toBe('draw');
  });

  it('selects a tool by number key and reports unmapped keys', () => {
    const { tool, selectByKey } = useEditorTool();
    expect(selectByKey('3')).toBe(true);
    expect(tool.value).toBe('split');
    expect(selectByKey('9')).toBe(false);
    expect(tool.value).toBe('split');
  });
});

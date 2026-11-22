/**
 * Complete idle doubles of the canvas interaction controllers: nothing is
 * previewed, no point hits anything, and every handler declines. Handlers are
 * `vi.fn` so a spec can assert on them; override the members a spec drives.
 */

import { vi } from 'vitest';
import { ref } from 'vue';
import type { AutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { ClipInteractions } from '@/ui/arrangement/use-clip-interactions';
import type { TakeInteractions } from '@/ui/arrangement/use-take-interactions';
import type { NoteInteractions } from '@/ui/piano-roll/use-note-interactions';

export function fakeClipInteractions(overrides: Partial<ClipInteractions> = {}): ClipInteractions {
  return {
    previewClip: ref(null),
    previewFades: ref(null),
    previewDraft: ref(null),
    previewMarquee: ref(null),
    previewClips: ref([]),
    cursor: ref('default'),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onDoubleClick: vi.fn(),
    hitClipAt: vi.fn(() => null),
    cancel: vi.fn(),
    ...overrides,
  };
}

export function fakeAutomationInteractions(
  overrides: Partial<AutomationInteractions> = {},
): AutomationInteractions {
  return {
    preview: ref(null),
    hover: ref(null),
    cursor: ref(null),
    onPointerDown: vi.fn(() => false),
    onPointerMove: vi.fn(() => false),
    onPointerUp: vi.fn(() => false),
    onDoubleClick: vi.fn(() => false),
    onContextMenu: vi.fn(() => false),
    cancel: vi.fn(),
    ...overrides,
  };
}

export function fakeTakeInteractions(overrides: Partial<TakeInteractions> = {}): TakeInteractions {
  return {
    preview: ref(null),
    cursor: ref(null),
    isTakeRowAt: vi.fn(() => false),
    onPointerDown: vi.fn(() => false),
    onPointerMove: vi.fn(() => false),
    onPointerUp: vi.fn(() => false),
    cancel: vi.fn(),
    ...overrides,
  };
}

export function fakeNoteInteractions(overrides: Partial<NoteInteractions> = {}): NoteInteractions {
  return {
    marquee: ref(null),
    previewNotes: ref(null),
    cursor: ref('default'),
    gestureReadout: ref(null),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onDoubleClick: vi.fn(),
    hitNoteAt: vi.fn(() => null),
    drawCellAt: vi.fn((ppq: number) => ({ startPpq: ppq, lengthPpq: 0 })),
    onKeyDown: vi.fn(() => false),
    cancel: vi.fn(),
    ...overrides,
  };
}

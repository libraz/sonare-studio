import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const arrangementView = readFileSync(
  resolve(process.cwd(), 'src/components/arrangement/ArrangementView.vue'),
  'utf8',
);

describe('arrangement loop split entry-point wiring', () => {
  it('routes split-tool rejection to the localized view error', () => {
    expect(arrangementView).toContain('onSplitBlocked: (_clipId, reason) =>');
    expect(arrangementView).toContain(
      "if (reason === 'loop') error.value = t.value.shell.arrangement.loopSplitUnavailable;",
    );
  });

  it('disables the context action with a visible reason', () => {
    expect(arrangementView).toContain('const splitBlocked = clipSplitBlockReason(clip, splitPpq);');
    expect(arrangementView).toContain('disabled: frozen || splitBlocked !== null');
    expect(arrangementView).toContain('t.value.shell.arrangement.loopSplitUnavailable}`');
  });

  it('rejects the playhead shortcut with the same localized reason', () => {
    expect(arrangementView).toContain("if (clipSplitBlockReason(target, ppq) === 'loop')");
    expect(arrangementView).toContain(
      'error.value = t.value.shell.arrangement.loopSplitUnavailable;',
    );
  });

  it('routes wheel input from the track-header column through the shared viewport handler', () => {
    expect(arrangementView).toContain(
      '<TrackHeaderList\n        class="cell-headers"\n        @wheel.prevent="onWheel"',
    );
    expect(arrangementView).toContain('event.currentTarget instanceof HTMLElement');
  });

  it('exposes the shared snap picker while working in the arrangement', () => {
    expect(arrangementView).toContain(
      "import { SNAP_CHOICES } from '@/ui/shell/app-shell-options';",
    );
    expect(arrangementView).toContain("const snapChoice = computed<number | 'bar'>({");
    expect(arrangementView).toContain('<SelectMenu\n          v-model="snapChoice"');
    expect(arrangementView).toContain(':options="SNAP_CHOICES"');
  });

  it('shares a view-local vertical zoom height between the headers and canvas', () => {
    expect(arrangementView).toContain('const laneHeight = ref(LANE_HEIGHT_PX);');
    expect(arrangementView).toContain('laneHeight.value,');
    expect(arrangementView).toContain(':lane-height="laneHeight"');
    expect(arrangementView).toContain('function zoomVertical(factor: number): void');
    expect(arrangementView).toContain('event.altKey');
  });

  it('exposes ripple insert and delete from the ruler context menu', () => {
    expect(arrangementView).toContain("id: 'insert-time'");
    expect(arrangementView).toContain("id: 'delete-time'");
    expect(arrangementView).toContain("rippleTimeFromPrompt('insert', payload.ppq)");
    expect(arrangementView).toContain("rippleTimeFromPrompt('delete', payload.ppq)");
    expect(arrangementView).toContain('if (isInsert) insertTime(ppq, lengthPpq);');
    expect(arrangementView).toContain('else deleteTime(ppq, ppq + lengthPpq);');
  });
});

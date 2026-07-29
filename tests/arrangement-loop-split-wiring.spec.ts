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
});

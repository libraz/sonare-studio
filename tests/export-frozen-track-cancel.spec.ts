import { describe, expect, it } from 'vitest';
import { buildAudioClips } from '@/export/engine-render-clips';
import type { ExportMediaIssue } from '@/export/mixdown';
import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';

class CancelledError extends Error {}

describe('frozen track audio while an export is cancelled', () => {
  it('propagates the cancel instead of reporting the frozen asset as unreadable', async () => {
    let cancelled = false;
    const mediaIssues: ExportMediaIssue[] = [];
    const doc = {
      tracks: [{ frozen: { assetId: 'frozen-a' }, clips: [] }],
    } as unknown as ProjectDocument;
    const build = buildAudioClips(doc, {
      trackIds: [1],
      tempoMap: normalizeTempoMap([]),
      sampleRate: 48000,
      loadAudio: async () => {
        cancelled = true;
        return {
          channels: [new Float32Array(16)],
          meta: { sampleRate: 48000 },
        } as never;
      },
      resampleAudio: (samples) => samples,
      checkCancel: () => {
        if (cancelled) throw new CancelledError('cancelled');
      },
      mediaIssues,
    });
    await expect(build).rejects.toBeInstanceOf(CancelledError);
    expect(mediaIssues).toEqual([]);
  });
});

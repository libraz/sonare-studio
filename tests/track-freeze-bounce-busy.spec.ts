import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { EditorTrack } from '@/project/types';
import { useTrackFreezeBounce } from '@/ui/arrangement/use-track-freeze-bounce';

const freezeMock = vi.hoisted(() => ({
  freezeTrack: vi.fn(),
  bounceTrackRange: vi.fn(),
  unfreezeTrack: vi.fn(),
}));
vi.mock('@/project/freeze', () => freezeMock);

function track(id: number, frozen = false): EditorTrack {
  return { id, frozen } as unknown as EditorTrack;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<string>((res) => {
    resolve = () => res('asset');
  });
  return { promise, resolve };
}

describe('track freeze and bounce busy state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('blocks freeze and bounce on every track while any render is in flight', async () => {
    const hold = deferred();
    freezeMock.freezeTrack.mockReturnValue(hold.promise);
    const fb = useTrackFreezeBounce({ props: {}, error: ref('') });
    const a = track(1);
    const b = track(2);
    expect(fb.freezeBlocked(b)).toBeNull();
    const pending = fb.onToggleFreeze(a);
    expect(fb.freezeBlocked(b)).not.toBeNull();
    expect(fb.bounceBlocked(b)).not.toBeNull();
    hold.resolve();
    await pending;
    expect(fb.freezeBlocked(b)).toBeNull();
    expect(fb.bounceBlocked(b)).toBeNull();
  });

  it('does not start a second freeze on another track while one is in flight', async () => {
    const hold = deferred();
    freezeMock.freezeTrack.mockReturnValue(hold.promise);
    const fb = useTrackFreezeBounce({ props: {}, error: ref('') });
    const pending = fb.onToggleFreeze(track(1));
    await fb.onToggleFreeze(track(2));
    expect(freezeMock.freezeTrack).toHaveBeenCalledTimes(1);
    hold.resolve();
    await pending;
  });

  it('still unfreezes a frozen track while another track renders', async () => {
    const hold = deferred();
    freezeMock.freezeTrack.mockReturnValue(hold.promise);
    const fb = useTrackFreezeBounce({ props: {}, error: ref('') });
    const pending = fb.onToggleFreeze(track(1));
    const frozen = track(2, true);
    expect(fb.freezeBlocked(frozen)).toBeNull();
    await fb.onToggleFreeze(frozen);
    expect(freezeMock.unfreezeTrack).toHaveBeenCalledWith(2);
    hold.resolve();
    await pending;
  });
});

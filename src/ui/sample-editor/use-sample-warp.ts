/**
 * Clip warp (tempo-follow) controls for the sample editor. Resolves the clip
 * whose warp state the editor edits, exposes its enabled/anchors/ratio-hint
 * state and the source-BPM input, and commits partial warp edits through the
 * undoable setClipWarp command.
 */

import { computed, ref, watch } from 'vue';
import { setClipWarp } from '@/project/commands';
import type { useProjectStore } from '@/project/store';
import type { ClipWarp } from '@/project/types';
import { defaultWarpAnchor, findWarpClip, mergedWarp, segmentStretchRatios } from './warp-controls';

/** Options for {@link useSampleWarp}. */
export interface UseSampleWarpOptions {
  /** Project store providing clips, the active clip and the project tempo. */
  project: ReturnType<typeof useProjectStore>;
  /** Id of the asset being edited (the warp clip must reference it). */
  assetId: () => string;
  /** Surfaces an error message to the editor's shared error banner. */
  setError: (message: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the warp controls. The numeric source-BPM input is mirrored from the
 * resolved clip and re-synced whenever the clip or its stored source BPM
 * changes (immediately on setup).
 */
export function useSampleWarp(options: UseSampleWarpOptions) {
  const { project, assetId, setError } = options;

  const warpClip = computed(() => findWarpClip(project.clips, project.clipId, assetId()));
  const warpEnabled = computed(() => warpClip.value?.warp?.enabled ?? false);
  const warpAnchors = computed(() => warpClip.value?.warp?.anchors ?? []);
  const warpRatioHint = computed(() => {
    const clip = warpClip.value;
    if (!clip) return '';
    return segmentStretchRatios(clip, project.tempoBpm)
      .map((ratio) => `×${ratio.toFixed(2)}`)
      .join(' · ');
  });

  const warpBpmInput = ref('');
  watch(
    () => [warpClip.value?.id, warpClip.value?.warp?.sourceBpm] as const,
    () => {
      warpBpmInput.value = String(warpClip.value?.warp?.sourceBpm ?? project.tempoBpm);
    },
    { immediate: true },
  );

  /** Applies a partial warp edit through the undoable setClipWarp command. */
  function commitWarp(overrides: Partial<ClipWarp>): void {
    const clip = warpClip.value;
    if (!clip) return;
    try {
      setClipWarp(clip.id, mergedWarp(clip.warp, overrides, project.tempoBpm));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function onToggleWarp(): void {
    commitWarp({ enabled: !warpEnabled.value });
  }

  function onWarpBpmChange(): void {
    const bpm = Number(warpBpmInput.value);
    if (!(warpBpmInput.value.trim().length > 0 && Number.isFinite(bpm)) || bpm <= 0) {
      warpBpmInput.value = String(warpClip.value?.warp?.sourceBpm ?? project.tempoBpm);
      return;
    }
    commitWarp({ sourceBpm: bpm });
  }

  function onAnchorEdit(index: number, field: 'ppq' | 'sourceSeconds', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    commitWarp({
      anchors: warpAnchors.value.map((anchor, i) =>
        i === index ? { ...anchor, [field]: value } : anchor,
      ),
    });
  }

  function onRemoveAnchor(index: number): void {
    commitWarp({ anchors: warpAnchors.value.filter((_, i) => i !== index) });
  }

  function onAddAnchor(): void {
    const clip = warpClip.value;
    if (!clip) return;
    const sourceBpm = clip.warp?.sourceBpm ?? project.tempoBpm;
    const anchor = defaultWarpAnchor(warpAnchors.value, clip.lengthPpq, sourceBpm);
    if (!anchor) return;
    commitWarp({ anchors: [...warpAnchors.value, anchor] });
  }

  return {
    warpClip,
    warpEnabled,
    warpAnchors,
    warpRatioHint,
    warpBpmInput,
    onToggleWarp,
    onWarpBpmChange,
    onAnchorEdit,
    onRemoveAnchor,
    onAddAnchor,
  };
}

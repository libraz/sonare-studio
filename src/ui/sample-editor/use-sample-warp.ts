/**
 * Clip warp (tempo-follow) controls for the sample editor. Resolves the clip
 * whose warp state the editor edits, exposes its enabled/anchors/ratio-hint
 * state and the source-BPM input, and commits partial warp edits through the
 * undoable setClipWarp command.
 */

import { computed, onScopeDispose, ref, watch } from 'vue';
import { downmixToMono } from '@/lib/audio-channels';
import { errorMessage } from '@/lib/errors';
import { OperationGeneration, type OperationIdentity } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { loadAsset } from '@/persistence/assets';
import { clipSourceWindowFrames } from '@/project/audible-clip-window';
import { setClipWarp } from '@/project/commands';
import type { useProjectStore } from '@/project/store';
import type { ClipWarp } from '@/project/types';
import {
  autoWarpFromBeatTimes,
  defaultWarpAnchor,
  findWarpClip,
  mergedWarp,
  segmentStretchRatios,
} from './warp-controls';

type BeatDetector = (samples: Float32Array, sampleRate?: number) => number[];

interface AutoWarpDeps {
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  detectBeats?: BeatDetector;
  detectDownbeats?: BeatDetector;
}

/** Options for {@link useSampleWarp}. */
export interface UseSampleWarpOptions {
  /** Project store providing clips, the active clip and the project tempo. */
  project: ReturnType<typeof useProjectStore>;
  /** Id of the asset being edited (the warp clip must reference it). */
  assetId: () => string;
  /** Surfaces an error message to the editor's shared error banner. */
  setError: (message: string) => void;
  /** Optional detector injection for tests or alternate runtimes. */
  autoWarp?: AutoWarpDeps;
}

/**
 * Builds the warp controls. The numeric source-BPM input is mirrored from the
 * resolved clip and re-synced whenever the clip or its stored source BPM
 * changes (immediately on setup).
 */
export function useSampleWarp(options: UseSampleWarpOptions) {
  const { project, assetId, setError } = options;
  let disposed = false;
  const autoWarpOperations = new OperationGeneration();

  const warpClip = computed(() => findWarpClip(project.clips, project.clipId, assetId()));
  const warpEnabled = computed(() => warpClip.value?.warp?.enabled ?? false);
  const warpAnchors = computed(() => warpClip.value?.warp?.anchors ?? []);
  const warpRatioHint = computed(() => {
    const clip = warpClip.value;
    if (!clip) return '';
    return segmentStretchRatios(clip, project.tempoBpm, project.tempoSegments)
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

  /** Anchor Add anchor would insert, or null when no gap can hold one. */
  const nextWarpAnchor = computed(() => {
    const clip = warpClip.value;
    if (!clip) return null;
    const sourceBpm = clip.warp?.sourceBpm ?? project.tempoBpm;
    return defaultWarpAnchor(warpAnchors.value, clip.lengthPpq, sourceBpm);
  });

  function onAddAnchor(): void {
    const anchor = nextWarpAnchor.value;
    if (!anchor) return;
    commitWarp({ anchors: [...warpAnchors.value, anchor] });
  }

  async function resolveAutoWarpDeps(): Promise<
    Required<Pick<AutoWarpDeps, 'loadAudioAsset'>> &
      Pick<AutoWarpDeps, 'detectBeats' | 'detectDownbeats'>
  > {
    if (options.autoWarp?.detectBeats) {
      return {
        loadAudioAsset: options.autoWarp.loadAudioAsset ?? loadAsset,
        detectBeats: options.autoWarp.detectBeats,
        detectDownbeats: options.autoWarp.detectDownbeats,
      };
    }
    const wasm = (await ensureWasm()) as unknown as {
      detectBeats?: BeatDetector;
      detectDownbeats?: BeatDetector;
    };
    return {
      loadAudioAsset: options.autoWarp?.loadAudioAsset ?? loadAsset,
      detectBeats: wasm.detectBeats,
      detectDownbeats: wasm.detectDownbeats,
    };
  }

  async function onAutoWarp(): Promise<void> {
    const clip = warpClip.value;
    if (!clip?.assetId) return;
    const identity = (): OperationIdentity => {
      const current = warpClip.value;
      return {
        projectId: project.documentGeneration,
        targetId: current?.id ?? null,
        revision: current
          ? JSON.stringify({
              assetId: current.assetId,
              startPpq: current.startPpq,
              sourceOffsetPpq: current.sourceOffsetPpq,
              lengthPpq: current.lengthPpq,
              warp: current.warp,
              tempoBpm: project.tempoBpm,
              tempoSegments: project.tempoSegments,
            })
          : null,
      };
    };
    const token = autoWarpOperations.begin(identity());
    const isCurrent = (): boolean => {
      return !disposed && autoWarpOperations.isCurrent(token, identity());
    };
    try {
      const deps = await resolveAutoWarpDeps();
      if (!isCurrent()) return;
      if (typeof deps.detectBeats !== 'function') throw new Error('Auto-Warp requires detectBeats');
      const asset = await deps.loadAudioAsset(clip.assetId);
      if (!isCurrent()) return;
      const sampleRate = asset.meta.sampleRate;
      const window = clipSourceWindowFrames(
        clip,
        asset.channels[0]?.length ?? 0,
        sampleRate,
        project.tempoBpm,
        project.tempoSegments,
      );
      const mono = downmixToMono(
        asset.channels.map((channel) => channel.slice(window.start, window.end)),
      );
      if (mono.length === 0) throw new Error('Auto-Warp requires a non-empty audio window');
      const beats = deps.detectBeats(mono, sampleRate);
      const downbeats =
        typeof deps.detectDownbeats === 'function' ? deps.detectDownbeats(mono, sampleRate) : [];
      const warp = autoWarpFromBeatTimes(beats, downbeats, clip.lengthPpq);
      if (!warp) throw new Error('Auto-Warp could not detect enough beats');
      if (!isCurrent()) return;
      // Anchors are seconds into the analysed window, so the warp must start there.
      commitWarp({
        enabled: true,
        sourceBpm: warp.sourceBpm,
        anchors: warp.anchors,
        sourceStartSeconds: window.start / sampleRate,
        sourceEndSeconds: window.end / sampleRate,
      });
    } catch (err) {
      if (!isCurrent()) return;
      setError(errorMessage(err));
    }
  }

  onScopeDispose(() => {
    disposed = true;
    autoWarpOperations.dispose();
  });

  return {
    warpClip,
    warpEnabled,
    warpAnchors,
    warpRatioHint,
    warpBpmInput,
    nextWarpAnchor,
    onToggleWarp,
    onWarpBpmChange,
    onAnchorEdit,
    onRemoveAnchor,
    onAddAnchor,
    onAutoWarp,
  };
}

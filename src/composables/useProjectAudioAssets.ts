import { computed, getCurrentScope, onScopeDispose, type Ref, ref } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { OperationGeneration, type OperationIdentity } from '@/lib/operation-generation';
import { leaseAudioAssets } from '@/persistence/asset-leases';
import { loadAsset, loadAssetMeta } from '@/persistence/assets';
import { analyzeAudioTags, decodeAndIngest, resolveAudioAnalysis } from '@/project/audio-import';
import {
  addAudioClip,
  addBouncedClip,
  replaceAudioClipAsset,
  setActiveClip,
  setClipWarp,
} from '@/project/commands';
import { sliceAudioClipWindow } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from '@/project/tempo-map';
import { isAudioClip } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

type RunAction = (action: () => Promise<void>) => Promise<void>;

export interface ProjectAudioAssetsOptions {
  closeProjectMenu: () => void;
  renderInfo: Ref<string>;
  positionPpq: Ref<number>;
  runAction: RunAction;
}

export function useProjectAudioAssets(options: ProjectAudioAssetsOptions) {
  const { closeProjectMenu, positionPpq, renderInfo, runAction } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  const audioImportInput = ref<HTMLInputElement | null>(null);
  const tempoDetectionOperations = new OperationGeneration();

  if (getCurrentScope()) {
    onScopeDispose(() => tempoDetectionOperations.dispose());
  }

  async function placeAssetAtPlayhead(assetId: string): Promise<number> {
    const lease = leaseAudioAssets([assetId]);
    try {
      const meta = await loadAssetMeta(assetId);
      const startPpq = Math.max(0, positionPpq.value);
      const tempoMap = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
      const startSeconds = ppqToSeconds(tempoMap, startPpq);
      const durationSeconds = meta.numFrames / meta.sampleRate;
      const lengthPpq = secondsToPpq(tempoMap, startSeconds + durationSeconds) - startPpq;
      const overlaps = (trackId: number): boolean =>
        store.clips.some(
          (clip) =>
            clip.trackId === trackId &&
            clip.startPpq < startPpq + lengthPpq &&
            startPpq < clip.startPpq + clip.lengthPpq,
        );
      const audioTrack = store.tracks.find(
        (track) => track.kind === 'audio' && !overlaps(track.id),
      );
      const newClipId = audioTrack
        ? await addAudioClip({
            trackId: audioTrack.id,
            assetId,
            startPpq,
            lengthPpq,
            name: meta.name,
          })
        : addBouncedClip({
            name: meta.name,
            assetId,
            startPpq,
            lengthPpq,
          });
      setActiveClip(newClipId);
      return newClipId;
    } finally {
      lease.release();
    }
  }

  function onAddAssetToProject(assetId: string): void {
    void runAction(async () => {
      await placeAssetAtPlayhead(assetId);
    });
  }

  function importAudioAction(): void {
    closeProjectMenu();
    audioImportInput.value?.click();
  }

  function onAudioImportChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;
    void runAction(async () => {
      for (const file of files) {
        const meta = await decodeAndIngest(file);
        await placeAssetAtPlayhead(meta.id);
      }
    });
  }

  const sampleAssetId = computed(() => {
    const clip = store.activeClip;
    return clip && isAudioClip(clip) && clip.assetId ? clip.assetId : null;
  });

  async function swapClipAsset(clipId: number, assetId: string): Promise<void> {
    const lease = leaseAudioAssets([assetId]);
    try {
      const clip = store.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const newClipId = replaceAudioClipAsset(clipId, assetId);
      setActiveClip(newClipId);
    } finally {
      lease.release();
    }
  }

  function onAssetCreated(newAssetId: string, sourceAssetId: string): void {
    const clip = store.activeClip;
    if (!clip || !isAudioClip(clip) || clip.assetId !== sourceAssetId) return;
    const clipId = clip.id;
    void (async () => {
      const lease = leaseAudioAssets([newAssetId]);
      try {
        const ok = await confirmDialog({
          title: t.value.dialogs.prompts.applyEditedAudioTitle,
          message: t.value.dialogs.prompts.applyEditedAudioMessage,
          confirmLabel: t.value.dialogs.prompts.useEdit,
        });
        if (!ok) return;
        await runAction(() => swapClipAsset(clipId, newAssetId));
      } finally {
        lease.release();
      }
    })();
  }

  function onApplyAsset(assetId: string): void {
    const clip = store.activeClip;
    if (!clip || !isAudioClip(clip) || clip.assetId === assetId) return;
    const clipId = clip.id;
    void runAction(() => swapClipAsset(clipId, assetId));
  }

  async function onRedetectClipTempo(clipId: number): Promise<void> {
    const clip = store.clips.find((c) => c.id === clipId);
    if (!clip || clip.assetId === undefined) return;
    const assetId = clip.assetId;
    await runAction(async () => {
      const identity = (): OperationIdentity => {
        const current = store.clips.find((entry) => entry.id === clipId);
        return {
          projectId: store.documentGeneration,
          targetId: current?.id ?? null,
          revision:
            current && isAudioClip(current)
              ? JSON.stringify({
                  assetId: current.assetId,
                  sourceOffsetPpq: current.sourceOffsetPpq,
                  lengthPpq: current.lengthPpq,
                  warp: current.warp,
                  tempoBpm: store.tempoBpm,
                  tempoSegments: store.tempoSegments,
                })
              : null,
        };
      };
      const token = tempoDetectionOperations.begin(identity());
      const isCurrent = (): boolean => tempoDetectionOperations.isCurrent(token, identity());
      const asset = await loadAsset(assetId);
      if (!isCurrent()) return;
      const analysis = await resolveAudioAnalysis();
      if (!isCurrent()) return;
      const channels = sliceAudioClipWindow(
        asset.channels,
        asset.meta.sampleRate,
        clip.sourceOffsetPpq,
        clip.lengthPpq,
        clip.warp?.sourceBpm ?? store.tempoBpm,
      );
      const tags = analyzeAudioTags(channels, asset.meta.sampleRate, analysis);
      if (tags.bpm === undefined) {
        renderInfo.value = t.value.dialogs.prompts.tempoDetectionFailed;
        return;
      }
      const current = store.clips.find((c) => c.id === clipId);
      if (!isCurrent() || !current || !isAudioClip(current)) return;
      const bpm = Math.round(tags.bpm * 10) / 10;
      setClipWarp(clipId, {
        ...(current.warp ?? {}),
        enabled: current.warp?.enabled ?? false,
        sourceBpm: bpm,
      });
      renderInfo.value = formatMessage(t.value.dialogs.prompts.tempoDetected, {
        bpm: bpm.toFixed(1),
      });
      if (tempoDetectionOperations.isCurrent(token)) tempoDetectionOperations.invalidate();
    });
  }

  return {
    audioImportInput,
    sampleAssetId,
    importAudioAction,
    onAddAssetToProject,
    onApplyAsset,
    onAssetCreated,
    onAudioImportChange,
    onRedetectClipTempo,
    placeAssetAtPlayhead,
  };
}

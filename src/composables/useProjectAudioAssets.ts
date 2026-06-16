import { computed, type Ref, ref } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { loadAsset, loadAssetMeta } from '@/persistence/assets';
import { analyzeAudioTags, decodeAndIngest, resolveAudioAnalysis } from '@/project/audio-import';
import {
  addAudioClip,
  addAudioTrack,
  deleteClip,
  setActiveClip,
  setClipWarp,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
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

  async function placeAssetAtPlayhead(assetId: string): Promise<number> {
    const meta = await loadAssetMeta(assetId);
    const startPpq = Math.max(0, positionPpq.value);
    const lengthPpq = (meta.numFrames / meta.sampleRate) * (store.tempoBpm / 60);
    const overlaps = (trackId: number): boolean =>
      store.clips.some(
        (clip) =>
          clip.trackId === trackId &&
          clip.startPpq < startPpq + lengthPpq &&
          startPpq < clip.startPpq + clip.lengthPpq,
      );
    const audioTrack = store.tracks.find((track) => track.kind === 'audio' && !overlaps(track.id));
    const trackId = audioTrack ? audioTrack.id : addAudioTrack();
    const newClipId = await addAudioClip({
      trackId,
      assetId,
      startPpq,
      lengthPpq,
      name: meta.name,
    });
    setActiveClip(newClipId);
    return newClipId;
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
    const clip = store.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const placement = {
      trackId: clip.trackId,
      startPpq: clip.startPpq,
      lengthPpq: clip.lengthPpq,
      gain: clip.gain,
      name: clip.name,
    };
    deleteClip(clipId);
    const newClipId = await addAudioClip({ assetId, ...placement });
    setActiveClip(newClipId);
  }

  function onAssetCreated(newAssetId: string, sourceAssetId: string): void {
    const clip = store.activeClip;
    if (!clip || !isAudioClip(clip) || clip.assetId !== sourceAssetId) return;
    const clipId = clip.id;
    void (async () => {
      const ok = await confirmDialog({
        title: t.value.dialogs.prompts.applyEditedAudioTitle,
        message: t.value.dialogs.prompts.applyEditedAudioMessage,
        confirmLabel: t.value.dialogs.prompts.useEdit,
      });
      if (!ok) return;
      void runAction(() => swapClipAsset(clipId, newAssetId));
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
      const asset = await loadAsset(assetId);
      const analysis = await resolveAudioAnalysis();
      const tags = analyzeAudioTags(asset.channels, asset.meta.sampleRate, analysis);
      if (tags.bpm === undefined) {
        renderInfo.value = t.value.dialogs.prompts.tempoDetectionFailed;
        return;
      }
      const bpm = Math.round(tags.bpm * 10) / 10;
      setClipWarp(clipId, {
        enabled: clip.warp?.enabled ?? false,
        sourceBpm: bpm,
        ...(clip.warp?.anchors ? { anchors: clip.warp.anchors } : {}),
      });
      renderInfo.value = formatMessage(t.value.dialogs.prompts.tempoDetected, {
        bpm: bpm.toFixed(1),
      });
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

/**
 * Versioned execution of offline sample operations: the staleness token that
 * rejects a result whose target, selection, history or project changed while it
 * ran, the shared {@link SampleOperationRunner.runOp} wrapper that stores each
 * result as a new immutable asset version, and the notices of the last commit.
 */

import { ref } from 'vue';
import { errorMessage } from '@/lib/errors';
import {
  type OperationToken as GenerationToken,
  OperationGeneration,
  type OperationIdentity,
} from '@/lib/operation-generation';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import { editedAssetName, pushVersion, type VersionHistoryState } from './history';
import { resolveRange, type SampleRange } from './ops';
import { runSampleOperationInWorker, type SampleOperation } from './ops-client';
import type { UseSampleOperationsOptions } from './use-sample-operations';

/** Editor state the runner reads and writes; a subset of the composable options. */
export type SampleOperationRunnerOptions = Pick<
  UseSampleOperationsOptions,
  | 'asset'
  | 'currentAssetId'
  | 'historyState'
  | 'busy'
  | 'error'
  | 'selRange'
  | 'loadCurrent'
  | 'emitAssetCreated'
  | 'isDisposed'
  | 'getProjectGeneration'
>;

/**
 * Creates the operation runner. `getReferenceAssetId` reads the Match EQ
 * reference id, which is part of an operation token's identity.
 */
export function createSampleOperationRunner(
  options: SampleOperationRunnerOptions,
  getReferenceAssetId: () => string | undefined,
) {
  const {
    asset,
    currentAssetId,
    historyState,
    busy,
    error,
    selRange,
    loadCurrent,
    emitAssetCreated,
  } = options;
  const project = useProjectStore();
  const operations = new OperationGeneration();
  /** Non-fatal notes about the last committed operation's result. */
  const notices = ref<string[]>([]);
  /** Neutral outcome of the last committed operation (e.g. the key auto-tune used). */
  const resultStatus = ref<string | null>(null);

  interface SampleOperationToken {
    operation: GenerationToken;
    targetAsset: LoadedAudioAsset;
    targetAssetId: string;
    history: VersionHistoryState;
    projectGeneration: number;
    range: SampleRange | null;
    referenceAssetId?: string;
  }

  const getProjectGeneration = options.getProjectGeneration ?? (() => project.documentGeneration);
  const isDisposed = (): boolean => operations.disposed || options.isDisposed?.() === true;

  function operationIdentity(
    targetAssetId: string,
    projectGeneration: number,
    history: VersionHistoryState,
    range: SampleRange | null,
    referenceId?: string,
  ): OperationIdentity {
    return {
      projectId: projectGeneration,
      targetId: targetAssetId,
      revision: [
        history.currentIndex,
        history.versions.length,
        range?.startFrame ?? '',
        range?.endFrame ?? '',
        referenceId ?? '',
      ].join(':'),
    };
  }

  function beginOperation(
    targetAsset: LoadedAudioAsset,
    referenceId?: string,
  ): SampleOperationToken {
    const range = selRange();
    const targetAssetId = currentAssetId.value;
    const history = historyState.value;
    const projectGeneration = getProjectGeneration();
    return {
      operation: operations.begin(
        operationIdentity(targetAssetId, projectGeneration, history, range, referenceId),
      ),
      targetAsset,
      targetAssetId,
      history,
      projectGeneration,
      range: range ? { ...range } : null,
      ...(referenceId !== undefined ? { referenceAssetId: referenceId } : {}),
    };
  }

  function operationIsCurrent(token: SampleOperationToken): boolean {
    const range = selRange();
    const referenceId = token.referenceAssetId === undefined ? undefined : getReferenceAssetId();
    return (
      !isDisposed() &&
      operations.isCurrent(
        token.operation,
        operationIdentity(
          currentAssetId.value,
          getProjectGeneration(),
          historyState.value,
          range,
          referenceId,
        ),
      ) &&
      token.targetAsset === asset.value &&
      token.targetAssetId === currentAssetId.value &&
      token.history === historyState.value &&
      token.projectGeneration === getProjectGeneration() &&
      token.referenceAssetId === referenceId &&
      token.range?.startFrame === range?.startFrame &&
      token.range?.endFrame === range?.endFrame
    );
  }

  /**
   * Runs one offline operation: produces new channel buffers, stores them as a
   * new asset version, records it in the history and switches to it. When the
   * result is byte-identical to the current version (same content hash) the
   * editor stays put. A label function is read after the result is produced.
   */
  async function runOp(
    label: string | (() => string),
    produce: (
      channels: Float32Array[],
      range: SampleRange,
      signal: AbortSignal,
    ) => Float32Array[] | Promise<Float32Array[]>,
  ): Promise<boolean> {
    const loaded = asset.value;
    if (!loaded || busy.value || isDisposed()) return false;
    const token = beginOperation(loaded);
    const assets = createAudioAssetTransaction();
    let committed = false;
    busy.value = true;
    error.value = null;
    notices.value = [];
    resultStatus.value = null;
    try {
      const range = resolveRange(loaded.channels, token.range);
      // Synchronous fallbacks copy shared asset channels. Worker operations
      // receive a defensive copy, transfer its ownership, and mutate it there.
      const result = produce(loaded.channels, range, token.operation.signal);
      const channels = result instanceof Promise ? await result : result;
      const meta = await assets.save(
        {
          name: editedAssetName(loaded.meta.name),
          sampleRate: loaded.meta.sampleRate,
        },
        channels,
      );
      if (!operationIsCurrent(token)) return false;
      if (meta.id !== token.targetAssetId) {
        const sourceAssetId = token.targetAssetId;
        historyState.value = pushVersion(historyState.value, {
          assetId: meta.id,
          label: typeof label === 'function' ? label() : label,
        });
        currentAssetId.value = meta.id;
        emitAssetCreated(meta.id, sourceAssetId);
        await loadCurrent(meta.id);
      }
      assets.commit();
      committed = true;
      return true;
    } catch (err) {
      if (operationIsCurrent(token)) error.value = errorMessage(err);
      return false;
    } finally {
      if (!committed) {
        await assets.rollback((assetId) =>
          historyState.value.versions.some((version) => version.assetId === assetId),
        );
      }
      busy.value = false;
    }
  }

  function runBuiltinOp(
    operation: SampleOperation,
    fallback: (channels: Float32Array[], range: SampleRange) => Float32Array[],
  ): (
    channels: Float32Array[],
    range: SampleRange,
    signal: AbortSignal,
  ) => Promise<Float32Array[]> | Float32Array[] {
    return (channels, range, signal) =>
      typeof Worker === 'undefined'
        ? fallback(channels, range)
        : runSampleOperationInWorker(operation, channels, range, { signal });
  }

  return {
    notices,
    resultStatus,
    beginOperation,
    operationIsCurrent,
    runOp,
    runBuiltinOp,
    invalidate: () => operations.invalidate(),
    dispose: () => operations.dispose(),
  };
}

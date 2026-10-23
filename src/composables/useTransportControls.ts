import { computed, onScopeDispose, type Ref, ref, type ShallowRef, watch } from 'vue';
import {
  barBeatFromPpq,
  formatBarBeatTick,
  parseBarBeatTick,
  ppqFromBarBeat,
} from '@/components/lists/bar-beat';
import type { useRecording } from '@/composables/useRecording';
import type { useTransport } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import { describeError } from '@/lib/errors';
import { setTempoSegments } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

type Recording = ReturnType<typeof useRecording>;
type Transport = ReturnType<typeof useTransport>;

export interface TransportControlsOptions {
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  isPlaying: Ref<boolean>;
  loopEnabled: Ref<boolean>;
  loopEndPpq: Ref<number>;
  loopStartPpq: Ref<number>;
  positionPpq: Ref<number>;
  recording: Recording;
  /** True while any audio or MIDI take is being recorded. */
  recordingActive: Ref<boolean>;
  tempo: Ref<number>;
  transport: Transport;
  ensureEngineStarted: () => Promise<EngineHandle | null>;
  onStopped: () => void;
  scheduleApply: () => void;
  syncTransportState: () => void;
}

export function formatSeconds(s: number): string {
  return s.toFixed(2);
}

export function useTransportControls(options: TransportControlsOptions) {
  const { t } = useI18n();
  const store = useProjectStore();
  const tempoInput = ref(options.tempo.value);
  const autoPunchEnabled = ref(false);
  const hasLocatorWindow = computed(() => options.loopEndPpq.value > options.loopStartPpq.value);
  const positionBbt = computed(() =>
    formatBarBeatTick(options.positionPpq.value, store.timeSignatures),
  );
  const bbtEditing = ref(false);
  const bbtDraft = ref('');
  const bbtDisplay = computed(() => (bbtEditing.value ? bbtDraft.value : positionBbt.value));

  let autoPunchArming = false;
  /** Set when a looping transport closed the auto-punch take; cleared by stop or toggling. */
  let autoPunchTaken = false;
  let disposed = false;
  let playbackStartGeneration = 0;

  function togglePlayback(): void {
    if (options.isPlaying.value) {
      options.transport.stop();
      return;
    }
    startPlayback();
  }

  function startPlayback(): void {
    if (options.isPlaying.value) return;
    if (!options.handle.value) {
      const generation = ++playbackStartGeneration;
      void options.ensureEngineStarted().then((h) => {
        if (disposed || generation !== playbackStartGeneration || options.isPlaying.value) return;
        if (h) playFromShownPosition();
      });
      return;
    }
    options.transport.resumeContext();
    playFromShownPosition();
  }

  function playFromShownPosition(): void {
    // Playing from the project end would only run on through silence.
    const end = projectEndPpq();
    if (end > 0 && options.positionPpq.value >= end) options.transport.seekPpq(0);
    options.transport.play();
  }

  function stopPlayback(): void {
    playbackStartGeneration++;
    if (options.handle.value) options.transport.stop();
  }

  function applyTempo(): void {
    const bpm = Number(tempoInput.value);
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    if (!store.initialized) {
      options.transport.setTempo(bpm);
      return;
    }
    try {
      const segments =
        store.tempoSegments.length > 0
          ? store.tempoSegments.map((segment, index) =>
              index === 0 ? { ...segment, bpm } : { ...segment },
            )
          : [{ startPpq: 0, bpm }];
      setTempoSegments(segments);
    } catch (err) {
      options.errorMessage.value = describeError(err, t.value.notices.errors);
    }
  }

  function toggleLoop(): void {
    const start =
      options.loopEndPpq.value > options.loopStartPpq.value ? options.loopStartPpq.value : 0;
    const end =
      options.loopEndPpq.value > options.loopStartPpq.value
        ? options.loopEndPpq.value
        : Math.max(8, ...store.clips.map((clip) => clip.startPpq + clip.lengthPpq));
    options.transport.setLoop(start, end, !options.loopEnabled.value);
  }

  function projectEndPpq(): number {
    return store.clips.reduce((max, clip) => Math.max(max, clip.startPpq + clip.lengthPpq), 0);
  }

  function seekToStart(): void {
    options.transport.seekPpq(0);
  }

  function seekToEnd(): void {
    options.transport.seekPpq(projectEndPpq());
  }

  function nudgeByBar(direction: -1 | 1): void {
    const { bar } = barBeatFromPpq(options.positionPpq.value, store.timeSignatures);
    const currentBarStart = ppqFromBarBeat({ bar, beat: 1 }, store.timeSignatures);
    const atLine = Math.abs(options.positionPpq.value - currentBarStart) < 1e-6;
    const targetBar = direction < 0 ? (atLine ? Math.max(1, bar - 1) : bar) : bar + 1;
    options.transport.seekPpq(ppqFromBarBeat({ bar: targetBar, beat: 1 }, store.timeSignatures));
  }

  function setLeftLocator(): void {
    const right =
      options.loopEndPpq.value > options.positionPpq.value
        ? options.loopEndPpq.value
        : projectEndPpq();
    if (right <= options.positionPpq.value) return;
    options.transport.setLoop(options.positionPpq.value, right, options.loopEnabled.value);
  }

  function setRightLocator(): void {
    const left =
      options.loopStartPpq.value < options.positionPpq.value ? options.loopStartPpq.value : 0;
    if (options.positionPpq.value <= left) return;
    options.transport.setLoop(left, options.positionPpq.value, options.loopEnabled.value);
  }

  function toggleAutoPunch(): void {
    autoPunchEnabled.value = !autoPunchEnabled.value;
    autoPunchTaken = false;
  }

  function onSeek(ppq: number): void {
    options.transport.seekPpq(ppq);
  }

  function onBbtFocus(): void {
    bbtEditing.value = true;
    bbtDraft.value = positionBbt.value;
  }

  function onBbtCommit(): void {
    if (!bbtEditing.value) return;
    bbtEditing.value = false;
    const ppq = parseBarBeatTick(bbtDraft.value, store.timeSignatures);
    if (ppq !== null) onSeek(ppq);
  }

  watch(options.isPlaying, (playing) => {
    if (playing) return;
    autoPunchTaken = false;
    options.onStopped();
  });

  watch(
    () => store.tempoBpm,
    (bpm) => {
      tempoInput.value = bpm;
      if (options.handle.value) {
        options.transport.setTempo(bpm);
        options.syncTransportState();
        options.scheduleApply();
      }
    },
  );

  // A new or loaded document starts stopped at its beginning.
  watch(
    () => store.documentGeneration,
    () => {
      stopPlayback();
      seekToStart();
    },
  );

  // Stop when the playhead crosses the project end, unless looping or recording.
  watch(options.positionPpq, (ppq, previous) => {
    if (!options.isPlaying.value || options.loopEnabled.value) return;
    if (options.recordingActive.value) return;
    const end = projectEndPpq();
    if (end > 0 && previous < end && ppq >= end) stopPlayback();
  });

  watch(options.positionPpq, (ppq, previous) => {
    if (!autoPunchEnabled.value || !options.isPlaying.value) return;
    if (options.recording.armedTrackId.value === null || !hasLocatorWindow.value) return;
    if (options.recording.isRecording.value) {
      // Close on the recorder's latency-extended boundary: render position
      // reaches the right locator `offset` samples before capture does. A
      // looping transport wraps at the right locator first, so the wrap closes it.
      const closeAtPpq = options.recording.capturePunchOutPpq();
      const wrapped = options.loopEnabled.value && ppq < previous - 1e-9;
      if (wrapped || (closeAtPpq !== null && ppq >= closeAtPpq)) {
        autoPunchTaken = wrapped;
        void options.recording.stopRecord();
      }
      return;
    }
    // One take per pass of the locator window: a wrap does not punch in again.
    if (autoPunchArming || autoPunchTaken || ppq >= options.loopEndPpq.value) return;
    // Punch in at the left locator when the playhead is still approaching it
    // (the engine opens a sample-accurate window there), or at the current
    // position when playback started inside the window — otherwise starting
    // past the locator would never arm and the take would be missed entirely.
    const punchAt = ppq <= options.loopStartPpq.value ? options.loopStartPpq.value : ppq;
    autoPunchArming = true;
    void options.recording.record(punchAt, options.loopEndPpq.value).finally(() => {
      autoPunchArming = false;
    });
  });

  onScopeDispose(() => {
    disposed = true;
    playbackStartGeneration++;
  });

  return {
    autoPunchEnabled,
    bbtDisplay,
    bbtDraft,
    bbtEditing,
    hasLocatorWindow,
    positionBbt,
    tempoInput,
    applyTempo,
    formatSeconds,
    nudgeByBar,
    onBbtCommit,
    onBbtFocus,
    onSeek,
    seekToEnd,
    seekToStart,
    setLeftLocator,
    setRightLocator,
    startPlayback,
    stopPlayback,
    toggleAutoPunch,
    toggleLoop,
    togglePlayback,
  };
}

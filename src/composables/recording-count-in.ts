import type { Ref } from 'vue';
import {
  type RecordingStartPlan,
  type RecordingTransportOwner,
  resolveAutoPunchRecordingStartPlan,
  resolveRecordingStartPlan,
} from '@/project/loop-recording';
import { type normalizeTempoMap, ppqRangeSeconds } from '@/project/tempo-map';
import type { TimeSignatureSegment } from '@/project/types';
import type { UseTransportReturn } from './useTransport';

/** Inputs of {@link resolveTransportRecordingPlan}. */
export interface TransportRecordingPlanInput {
  /** Plan already resolved by the shared audio+MIDI path; consumed verbatim. */
  suppliedPlan: RecordingStartPlan | null;
  /** Explicit punch-in position; a finite non-negative value selects auto-punch resolution. */
  legacyStart: number | undefined;
  transport: UseTransportReturn;
  countInBars: number;
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
  /** Which recorder drives the transport for this plan. */
  transportOwner: RecordingTransportOwner;
}

/** Resolves the recording start plan from live transport state unless one was supplied. */
export function resolveTransportRecordingPlan(
  input: TransportRecordingPlanInput,
): RecordingStartPlan {
  if (input.suppliedPlan) return input.suppliedPlan;
  const { transport, legacyStart } = input;
  const common = {
    positionPpq: transport.positionPpq.value,
    audiblePositionPpq: transport.audiblePositionPpq.value,
    startedFromRest: !transport.isPlaying.value,
    loopEnabled: transport.loopEnabled.value,
    loopStartPpq: transport.loopStartPpq.value,
    loopEndPpq: transport.loopEndPpq.value,
    countInBars: input.countInBars,
    timeSignatures: input.timeSignatures,
    transportOwner: input.transportOwner,
  };
  return legacyStart !== undefined && Number.isFinite(legacyStart) && legacyStart >= 0
    ? resolveAutoPunchRecordingStartPlan({ ...common, requestedStartPpq: legacyStart })
    : resolveRecordingStartPlan(common);
}

/** Count-in timer and forced-metronome bookkeeping shared by the audio and MIDI recorders. */
export interface CountInController {
  /** Turns the metronome on for the count-in, remembering to restore it in {@link finish}. */
  forceMetronome(): void;
  /**
   * Flags the count-in as running and schedules its end.
   *
   * @param plan Plan whose count-in range sets the duration.
   * @param tempoMap Tempo map the range is measured on.
   * @param extraMs Added to the musical duration (output latency of the audible count-in).
   * @param onElapsed Runs when the timer fires, before the count-in is finished.
   */
  begin(
    plan: RecordingStartPlan,
    tempoMap: ReturnType<typeof normalizeTempoMap>,
    extraMs: number,
    onElapsed?: () => void,
  ): void;
  /** Cancels the timer, clears the flag and restores the metronome when it was forced on. */
  finish(): void;
}

/** Creates the count-in controller for one recorder. */
export function createCountInController(
  transport: UseTransportReturn,
  isCountingIn: Ref<boolean>,
): CountInController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let restoreMetronomeOff = false;
  const finish = (): void => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    isCountingIn.value = false;
    if (restoreMetronomeOff) {
      restoreMetronomeOff = false;
      transport.toggleMetronome(false);
    }
  };
  return {
    forceMetronome() {
      if (transport.metronomeEnabled.value) return;
      transport.toggleMetronome(true);
      restoreMetronomeOff = true;
    },
    begin(plan, tempoMap, extraMs, onElapsed) {
      isCountingIn.value = true;
      timer = globalThis.setTimeout(
        () => {
          timer = null;
          onElapsed?.();
          finish();
        },
        ppqRangeSeconds(tempoMap, plan.countInStartPpq, plan.countInEndPpq) * 1000 + extraMs,
      );
    },
    finish,
  };
}

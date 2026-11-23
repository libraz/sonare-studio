import { computed, type Ref, ref } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { describeError } from '@/lib/errors';
import { applyNoteEdits } from '@/project/commands';
import { audibleMidiSourceWindow } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  bakePattern,
  isEmptyPlan,
  patternFromNotes,
  planNoteReplacement,
  trimBakedNotesToWindow,
} from '@/ui/step-sequencer/bake';
import type { StepPattern } from '@/ui/step-sequencer/pattern';
import { patternLengthPpq } from '@/ui/step-sequencer/timing';

/** How Apply resolves a pattern whose span exceeds the audible clip window. */
type OverflowPolicy = 'resize' | 'loop' | 'trim';

/** Inputs the clip bake reads from the sequencer. */
interface StepClipBakeInputs {
  pattern: Ref<StepPattern>;
  setPattern: (next: StepPattern) => void;
  report: (text: string, type: 'info' | 'warning' | 'error') => void;
}

/**
 * Owns Apply to clip / Pull from clip: the overflow policy, whether the active
 * clip can be targeted or written, the blocked reasons and both operations.
 */
export function useStepClipBake({ pattern, setPattern, report }: StepClipBakeInputs) {
  const store = useProjectStore();
  const { t } = useI18n();

  const overflowPolicy = ref<OverflowPolicy>('trim');

  /** True when the active clip exists and holds MIDI content. */
  const canTargetClip = computed(() => {
    const clip = store.activeClip;
    return clip !== null && clipKind(clip) === 'midi';
  });

  /** Frozen content remains available to Pull, but Apply cannot mutate it. */
  const contentReadOnly = computed(() => {
    const clip = store.activeClip;
    return (
      clip !== null && store.tracks.find((track) => track.id === clip.trackId)?.frozen !== undefined
    );
  });
  const pullBlocked = computed(() =>
    firstBlock([!canTargetClip.value, t.value.reasons.noMidiClip]),
  );
  const applyBlocked = computed(() =>
    firstBlock(pullBlocked.value, [contentReadOnly.value, t.value.reasons.trackFrozen]),
  );

  const overflowPolicyOptions = computed<ReadonlyArray<{ value: OverflowPolicy; label: string }>>(
    () => [
      { value: 'resize', label: t.value.shell.stepSequencer.overflow.resize },
      { value: 'loop', label: t.value.shell.stepSequencer.overflow.loop },
      { value: 'trim', label: t.value.shell.stepSequencer.overflow.trim },
    ],
  );

  async function applyToClip(): Promise<void> {
    const clip = store.activeClip;
    if (!clip || !canTargetClip.value) {
      report(t.value.shell.stepSequencer.status.noActiveApply, 'warning');
      return;
    }
    if (contentReadOnly.value) {
      report(t.value.shell.arrangement.trackHeader.unfreezeTitle, 'warning');
      return;
    }
    const spanPpq = patternLengthPpq(pattern.value.stepCount, pattern.value.resolution);
    const sourceWindow = audibleMidiSourceWindow(clip);
    const overflows = spanPpq > sourceWindow.lengthPpq + 1e-9;
    let baked = bakePattern(pattern.value, { basePpq: clip.sourceOffsetPpq });
    let clipWindow: Parameters<typeof applyNoteEdits>[0]['clipWindow'];
    if (overflows) {
      const policyLabel = overflowPolicyOptions.value.find(
        (option) => option.value === overflowPolicy.value,
      )?.label;
      const proceed = await confirmDialog({
        title: t.value.shell.stepSequencer.overflow.confirmTitle,
        message: formatMessage(t.value.shell.stepSequencer.overflow.confirmMessage, {
          pattern: spanPpq,
          clip: sourceWindow.lengthPpq,
          policy: policyLabel ?? overflowPolicy.value,
        }),
        confirmLabel: t.value.common.apply,
      });
      if (!proceed) {
        report(t.value.shell.stepSequencer.overflow.cancelled, 'warning');
        return;
      }
      if (overflowPolicy.value === 'resize') {
        clipWindow = {
          lengthPpq: Math.max(clip.lengthPpq, spanPpq),
          loopEnabled: false,
        };
      } else {
        baked = trimBakedNotesToWindow(baked, sourceWindow.startPpq, sourceWindow.lengthPpq);
        if (overflowPolicy.value === 'loop') {
          clipWindow = {
            lengthPpq: Math.max(clip.lengthPpq, spanPpq),
            loopEnabled: true,
            loopLengthPpq: sourceWindow.lengthPpq,
          };
        }
      }
    }
    const plan = {
      ...planNoteReplacement(store.notes, baked),
      ...(clipWindow ? { clipWindow } : {}),
    };
    if (isEmptyPlan(plan) && !clipWindow) {
      report(t.value.shell.stepSequencer.status.alreadyMatches, 'info');
      return;
    }
    try {
      applyNoteEdits(plan);
    } catch (err) {
      report(describeError(err, t.value.notices.errors), 'error');
      return;
    }
    report(
      formatMessage(t.value.shell.stepSequencer.status.applied, {
        count: baked.length,
        name: clip.name,
      }),
      'info',
    );
  }

  function pullFromClip(): void {
    const clip = store.activeClip;
    if (!clip || !canTargetClip.value) {
      report(t.value.shell.stepSequencer.status.noActivePull, 'warning');
      return;
    }
    let result: ReturnType<typeof patternFromNotes>;
    try {
      result = patternFromNotes(store.notes, pattern.value, clip.sourceOffsetPpq);
    } catch (err) {
      report(describeError(err, t.value.notices.errors), 'error');
      return;
    }
    setPattern(result.pattern);
    const captured = store.notes.length - result.droppedNotes;
    if (result.droppedNotes > 0) {
      report(
        formatMessage(t.value.shell.stepSequencer.status.pulledDropped, {
          count: captured,
          dropped: result.droppedNotes,
        }),
        'warning',
      );
    } else {
      report(
        formatMessage(t.value.shell.stepSequencer.status.pulled, {
          count: captured,
          name: clip.name,
        }),
        'info',
      );
    }
  }

  return {
    overflowPolicy,
    overflowPolicyOptions,
    contentReadOnly,
    pullBlocked,
    applyBlocked,
    applyToClip,
    pullFromClip,
  };
}

import { computed, getCurrentScope, onScopeDispose, type Ref, ref } from 'vue';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useMusicTyping } from '@/composables/useMusicTyping';
import type { useStepInput } from '@/composables/useStepInput';
import { useWebMidi } from '@/composables/useWebMidi';
import type { RealtimeEngine } from '@/wasm/index.js';

type StepInput = ReturnType<typeof useStepInput>;
type RunAction = (action: () => Promise<void>) => Promise<void>;
type RecordNoteEvent = { pitch: number; velocity: number; channel: number; timeStampMs?: number };
type RecordCcEvent = { controller: number; value: number; channel: number; timeStampMs?: number };
type RecordPitchBendEvent = { value: number; channel: number; timeStampMs?: number };
type RecordProgramChangeEvent = { program: number; channel: number; timeStampMs?: number };
type RecordChannelPressureEvent = { value: number; channel: number; timeStampMs?: number };
type RecordPolyPressureEvent = {
  pitch: number;
  value: number;
  channel: number;
  timeStampMs?: number;
};

export interface InputControlsOptions {
  errorMessage: Ref<string>;
  positionPpq: Ref<number>;
  stepInput: StepInput;
  ensureWasm: () => Promise<{ RealtimeEngine: new () => RealtimeEngine }>;
  previewNote: (pitch: number, velocity: number) => Promise<void>;
  /** Starts a sustained live note (held MIDI key) on the audible engine. */
  previewNoteOn: (pitch: number, velocity: number) => Promise<void>;
  /** Releases a sustained live note started by previewNoteOn. */
  previewNoteOff: (pitch: number) => void;
  /** Captures an incoming note-on for MIDI recording (when armed/rolling). */
  onRecordNoteOn?: (event: RecordNoteEvent) => void;
  /** Captures an incoming note-off for MIDI recording (when armed/rolling). */
  onRecordNoteOff?: (event: RecordNoteEvent) => void;
  /** Captures incoming CC for MIDI recording (when armed/rolling). */
  onRecordControlChange?: (event: RecordCcEvent) => void;
  /** Captures incoming pitch bend for MIDI recording (when armed/rolling). */
  onRecordPitchBend?: (event: RecordPitchBendEvent) => void;
  /** Captures incoming program changes for MIDI recording (when armed/rolling). */
  onRecordProgramChange?: (event: RecordProgramChangeEvent) => void;
  /** Captures incoming channel pressure for MIDI recording (when armed/rolling). */
  onRecordChannelPressure?: (event: RecordChannelPressureEvent) => void;
  /** Captures incoming polyphonic key pressure for MIDI recording (when armed/rolling). */
  onRecordPolyPressure?: (event: RecordPolyPressureEvent) => void;
  runAction: RunAction;
}

const MIDI_INPUT_ALL = '';

export function useInputControls(options: InputControlsOptions) {
  const {
    errorMessage,
    positionPpq,
    previewNote,
    previewNoteOn,
    previewNoteOff,
    runAction,
    stepInput,
  } = options;
  const musicTyping = useMusicTyping({
    onNoteOn: ({ pitch, velocity }) => {
      void previewNote(pitch, velocity);
    },
    stepInput,
  });

  const midiLearn = useMidiLearn();
  const midiLearnOpen = ref(false);
  const webMidi = useWebMidi({
    // Live MIDI keys sustain through the audible engine: note-on rings until the
    // matching key release, instead of a fixed-length blip.
    onNoteOn: (event) => {
      const { pitch, velocity } = event;
      void previewNoteOn(pitch, velocity);
      stepInput.enterNote(pitch, velocity);
      options.onRecordNoteOn?.(event);
    },
    onNoteOff: (event) => {
      previewNoteOff(event.pitch);
      options.onRecordNoteOff?.(event);
    },
    onControlChange: (event) => {
      midiLearn.handleCc(event);
      options.onRecordControlChange?.(event);
    },
    onPitchBend: (event) => options.onRecordPitchBend?.(event),
    onProgramChange: (event) => options.onRecordProgramChange?.(event),
    onChannelPressure: (event) => options.onRecordChannelPressure?.(event),
    onPolyPressure: (event) => options.onRecordPolyPressure?.(event),
  });

  const midiInputChoices = computed(() => [
    { value: MIDI_INPUT_ALL, label: 'All inputs' },
    ...webMidi.inputs.value.map((input) => ({ value: input.id, label: input.name ?? input.id })),
  ]);

  const midiInputSelection = computed<string>({
    get: () => webMidi.selectedInputId.value ?? MIDI_INPUT_ALL,
    set: (value) => {
      webMidi.selectedInputId.value = value === MIDI_INPUT_ALL ? null : value;
    },
  });

  let midiRoutingEngine: RealtimeEngine | null = null;

  function toggleMusicTyping(): void {
    if (musicTyping.enabled.value) musicTyping.disable();
    else musicTyping.enable();
  }

  function toggleStepInput(): void {
    if (stepInput.armed.value) stepInput.disarm();
    else stepInput.arm(positionPpq.value);
  }

  function connectWebMidi(): Promise<void> {
    return runAction(async () => {
      const wasm = await options.ensureWasm();
      if (!midiRoutingEngine) midiRoutingEngine = new wasm.RealtimeEngine();
      const ok = await webMidi.connect(midiRoutingEngine);
      if (!ok) {
        errorMessage.value = webMidi.error.value ?? 'Web MIDI is unavailable in this browser.';
      }
    });
  }

  // Release the binding's routing engine when the owning scope disposes, so the
  // wasm instance is not leaked across engine restarts / unmounts.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      webMidi.disconnect();
      midiRoutingEngine?.destroy();
      midiRoutingEngine = null;
    });
  }

  return {
    midiInputChoices,
    midiInputSelection,
    midiLearn,
    midiLearnOpen,
    musicTyping,
    webMidi,
    connectWebMidi,
    toggleMusicTyping,
    toggleStepInput,
  };
}

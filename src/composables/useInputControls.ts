import { computed, type Ref, ref } from 'vue';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useMusicTyping } from '@/composables/useMusicTyping';
import type { useStepInput } from '@/composables/useStepInput';
import { useWebMidi } from '@/composables/useWebMidi';
import type { RealtimeEngine } from '@/wasm/index.js';

type StepInput = ReturnType<typeof useStepInput>;
type RunAction = (action: () => Promise<void>) => Promise<void>;

export interface InputControlsOptions {
  errorMessage: Ref<string>;
  positionPpq: Ref<number>;
  stepInput: StepInput;
  ensureWasm: () => Promise<{ RealtimeEngine: new () => RealtimeEngine }>;
  previewNote: (pitch: number, velocity: number) => Promise<void>;
  runAction: RunAction;
}

const MIDI_INPUT_ALL = '';

export function useInputControls(options: InputControlsOptions) {
  const { errorMessage, positionPpq, previewNote, runAction, stepInput } = options;
  const musicTyping = useMusicTyping({
    onNoteOn: ({ pitch, velocity }) => {
      void previewNote(pitch, velocity);
    },
    stepInput,
  });

  const midiLearn = useMidiLearn();
  const midiLearnOpen = ref(false);
  const webMidi = useWebMidi({
    onNoteOn: ({ pitch, velocity }) => {
      void previewNote(pitch, velocity);
      stepInput.enterNote(pitch, velocity);
    },
    onControlChange: (event) => midiLearn.handleCc(event),
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

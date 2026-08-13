import { computed, getCurrentScope, onScopeDispose, type Ref, ref, watch } from 'vue';
import { type ControlSurfaceOptions, useControlSurface } from '@/composables/useControlSurface';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useMusicTyping } from '@/composables/useMusicTyping';
import type { LiveMidiChannelVoiceMessage } from '@/composables/useNotePreview';
import type { useStepInput } from '@/composables/useStepInput';
import { useWebMidi } from '@/composables/useWebMidi';
import { useI18n } from '@/ui/i18n';
import type { MidiLearnTransportAction } from '@/ui/midi/midi-learn';
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
  previewNoteOn: (
    pitch: number,
    velocity: number,
    channel?: number,
    timestampMs?: number,
  ) => Promise<void>;
  /** Releases a sustained live note started by previewNoteOn. */
  previewNoteOff: (
    pitch: number,
    channel?: number,
    velocity?: number,
    timestampMs?: number,
  ) => void;
  /** Routes non-note channel voice to the active MIDI track. */
  previewChannelVoice: (message: LiveMidiChannelVoiceMessage) => Promise<void>;
  /**
   * True while a MIDI recording take is capturing. Live notes are then routed
   * to the take; step input is suppressed so a played note is not entered twice
   * (once recorded, once step-inserted) when both are armed at the same time.
   */
  recordingActive?: Ref<boolean>;
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
  /**
   * Transport actions a learned control-surface button drives. Omit to leave
   * transport bindings inert (they still persist with the project).
   */
  transportActions?: Partial<Record<MidiLearnTransportAction, () => void>>;
  /** Moves the playhead back (a surface REWIND button). */
  rewind?: () => void;
  /** Moves the playhead forward (a surface FAST-FORWARD button). */
  forward?: () => void;
  /** Toggles a track's record arm from a surface or a learned button. */
  toggleTrackArm?: (trackId: number) => void;
  /** Focuses a track from a surface SELECT button. */
  selectTrack?: (trackId: number) => void;
  /** True while the transport rolls; lights a surface's PLAY lamp. */
  isPlaying?: Ref<boolean>;
  /** True while recording; lights a surface's RECORD lamp. */
  isRecording?: Ref<boolean>;
  /** True while cycle is enabled; lights a surface's CYCLE lamp. */
  isLooping?: Ref<boolean>;
  /** Record-armed tracks; lights a surface's ARM lamps. */
  armedTrackIds?: Ref<readonly number[]>;
  /** Live engine meter source lookup for the surface's strip meters. */
  trackMeterSource?: ControlSurfaceOptions['trackMeterSource'];
  runAction: RunAction;
}

const MIDI_INPUT_ALL = '';

export function useInputControls(options: InputControlsOptions) {
  const { t } = useI18n();
  const {
    errorMessage,
    positionPpq,
    previewNoteOn,
    previewNoteOff,
    previewChannelVoice,
    runAction,
    stepInput,
  } = options;
  const musicTyping = useMusicTyping({
    onNoteOn: ({ pitch, velocity }) => {
      void previewNoteOn(pitch, velocity);
    },
    onNoteOff: ({ pitch }) => previewNoteOff(pitch),
    stepInput,
  });

  const midiLearn = useMidiLearn({
    ...(options.transportActions === undefined ? {} : { transport: options.transportActions }),
    ...(options.toggleTrackArm === undefined ? {} : { toggleTrackArm: options.toggleTrackArm }),
    ...(options.selectTrack === undefined ? {} : { selectTrack: options.selectTrack }),
  });
  const controlSurface = useControlSurface({
    learn: midiLearn,
    ...(options.transportActions === undefined ? {} : { transport: options.transportActions }),
    ...(options.rewind === undefined ? {} : { rewind: options.rewind }),
    ...(options.forward === undefined ? {} : { forward: options.forward }),
    ...(options.toggleTrackArm === undefined ? {} : { toggleTrackArm: options.toggleTrackArm }),
    ...(options.selectTrack === undefined ? {} : { selectTrack: options.selectTrack }),
    ...(options.isPlaying === undefined ? {} : { isPlaying: options.isPlaying }),
    ...(options.isRecording === undefined ? {} : { isRecording: options.isRecording }),
    ...(options.isLooping === undefined ? {} : { isLooping: options.isLooping }),
    ...(options.armedTrackIds === undefined ? {} : { armedTrackIds: options.armedTrackIds }),
    ...(options.trackMeterSource === undefined
      ? {}
      : { trackMeterSource: options.trackMeterSource }),
  });
  const midiLearnOpen = ref(false);
  const webMidi = useWebMidi({
    // Live MIDI keys sustain through the audible engine: note-on rings until the
    // matching key release, instead of a fixed-length blip.
    onNoteOn: (event) => {
      const { pitch, velocity } = event;
      void previewNoteOn(pitch, velocity, event.channel, event.timeStampMs);
      // While a take is capturing, the note is recorded below; also step-entering
      // it would write the same note twice. Recording takes precedence.
      if (!options.recordingActive?.value) stepInput.enterNote(pitch, velocity);
      options.onRecordNoteOn?.(event);
    },
    onNoteOff: (event) => {
      previewNoteOff(event.pitch, event.channel, event.velocity, event.timeStampMs);
      options.onRecordNoteOff?.(event);
    },
    onControlChange: (event) => {
      void previewChannelVoice({
        kind: 'cc',
        controller: event.controller,
        value: event.value,
        channel: event.channel,
        timeStampMs: event.timeStampMs,
      });
      midiLearn.handleCc(event);
      options.onRecordControlChange?.(event);
    },
    onPitchBend: (event) => {
      void previewChannelVoice({ kind: 'pitch-bend', ...event });
      options.onRecordPitchBend?.(event);
    },
    onProgramChange: (event) => {
      void previewChannelVoice({ kind: 'program-change', ...event });
      options.onRecordProgramChange?.(event);
    },
    onChannelPressure: (event) => {
      void previewChannelVoice({ kind: 'channel-pressure', ...event });
      options.onRecordChannelPressure?.(event);
    },
    onPolyPressure: (event) => {
      void previewChannelVoice({ kind: 'poly-pressure', ...event });
      options.onRecordPolyPressure?.(event);
    },
  });

  const midiInputChoices = computed(() => [
    { value: MIDI_INPUT_ALL, label: t.value.shell.transport.midiInputAll },
    ...webMidi.inputs.value.map((input) => ({ value: input.id, label: input.name ?? input.id })),
  ]);

  const midiInputSelection = computed<string>({
    get: () => webMidi.selectedInputId.value ?? MIDI_INPUT_ALL,
    set: (value) => {
      webMidi.selectedInputId.value = value === MIDI_INPUT_ALL ? null : value;
    },
  });

  // A surface's buttons arrive as note-ons. Keeping its port out of the engine
  // binding is what stops every button press from playing the instrument and
  // landing in a recording take.
  watch(
    controlSurface.excludedInputIds,
    (next) => {
      webMidi.excludedInputIds.value = next;
    },
    { immediate: true },
  );

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
      // The surface claims its port first so the musical binding can exclude it
      // in the same pass instead of briefly routing it to the instrument.
      await controlSurface.refresh();
      const ok = await webMidi.connect(midiRoutingEngine);
      // A surface that owns the only port leaves nothing musical to bind, which
      // reports as `false` with no failure recorded — not something to surface
      // as an error.
      if (!ok && (webMidi.error.value !== null || webMidi.available.value === false)) {
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
    controlSurface,
    connectWebMidi,
    toggleMusicTyping,
    toggleStepInput,
  };
}

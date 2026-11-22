/**
 * Complete doubles of composable return values. Every method is a `vi.fn` so a
 * spec can assert on it; a spec overrides only the members it drives.
 */

import { vi } from 'vitest';
import { ref } from 'vue';
import type { UseMidiRecordingReturn } from '@/composables/useMidiRecording';
import type { UseRecordingReturn } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import { createRecordingCycle } from '@/project/loop-recording';

/**
 * A stopped transport at 120 BPM with the loop off. The recording cycle is
 * built over the loop refs the result ends up holding, overridden or not.
 */
export function fakeTransport(overrides: Partial<UseTransportReturn> = {}): UseTransportReturn {
  const loopEnabled = overrides.loopEnabled ?? ref(false);
  const loopStartPpq = overrides.loopStartPpq ?? ref(0);
  const loopEndPpq = overrides.loopEndPpq ?? ref(0);
  return {
    isPlaying: ref(false),
    positionSeconds: ref(0),
    positionPpq: ref(0),
    audiblePositionSeconds: ref(0),
    audiblePositionPpq: ref(0),
    tempo: ref(120),
    tempoSegments: ref([]),
    metronomeEnabled: ref(false),
    playbackLatencySeconds: ref(0),
    play: vi.fn(() => true),
    stop: vi.fn(() => true),
    seek: vi.fn(() => true),
    seekPpq: vi.fn(() => true),
    resumeContext: vi.fn(),
    setTempo: vi.fn(),
    setTempoMap: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome: vi.fn(() => false),
    dispose: vi.fn(),
    ...overrides,
    loopEnabled,
    loopStartPpq,
    loopEndPpq,
    recordingCycle:
      overrides.recordingCycle ??
      createRecordingCycle({ enabled: loopEnabled, startPpq: loopStartPpq, endPpq: loopEndPpq }),
  };
}

/** An idle, unarmed audio recorder with no microphone. */
export function fakeRecording(overrides: Partial<UseRecordingReturn> = {}): UseRecordingReturn {
  return {
    state: ref('idle'),
    armedTrackId: ref(null),
    armedTrackIds: ref([]),
    isRecording: ref(false),
    isCountingIn: ref(false),
    inputLevel: ref(0),
    micReady: ref(false),
    monitorEnabled: ref(false),
    countInBars: ref(0),
    voiceChangerPreset: ref('off'),
    streamingRetuneSemitones: ref(0),
    captureSource: ref('input'),
    inputDeviceId: ref(''),
    error: ref(null),
    capturePunchOutPpq: vi.fn(() => null),
    requestMic: vi.fn(async () => false),
    arm: vi.fn(),
    setTrackArmed: vi.fn(),
    setMonitor: vi.fn(),
    setVoiceChangerPreset: vi.fn(),
    setStreamingRetuneSemitones: vi.fn(),
    setCaptureSource: vi.fn(),
    setInputDeviceId: vi.fn(),
    record: vi.fn(async () => false),
    stopRecord: vi.fn(async () => null),
    dispose: vi.fn(),
    ...overrides,
  };
}

/** An idle, unarmed MIDI recorder recording cycle passes as takes. */
export function fakeMidiRecording(
  overrides: Partial<UseMidiRecordingReturn> = {},
): UseMidiRecordingReturn {
  return {
    armedTrackId: ref(null),
    isRecording: ref(false),
    isCountingIn: ref(false),
    countInBars: ref(0),
    error: ref(null),
    inputQuantizeDenominator: ref(0),
    cycleRecordMode: ref('takes'),
    arm: vi.fn(),
    captureNoteOn: vi.fn(),
    captureNoteOff: vi.fn(),
    captureControlChange: vi.fn(),
    capturePitchBend: vi.fn(),
    captureProgramChange: vi.fn(),
    captureChannelPressure: vi.fn(),
    capturePolyPressure: vi.fn(),
    record: vi.fn(() => false),
    stopRecord: vi.fn(() => null),
    dispose: vi.fn(),
    ...overrides,
  };
}

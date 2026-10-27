/** Error and status messages composables publish to the app banners. */
export const notices = {
  engineNotStarted: 'Start the engine first.',
  engineProcessorCrashed: 'Engine worklet processor crashed during processing (onprocessorerror).',
  engineCleanupFailed: 'Engine cleanup had {count} failure(s): {details}',
  musicXmlUnavailable: {
    'active-midi-clip-required': 'Select a MIDI clip to export it as MusicXML.',
    'midi-track-required': 'Add a MIDI track to export a score as MusicXML.',
    'score-window-required': 'The project has no score range to export as MusicXML.',
    unknown: 'MusicXML export is not available right now.',
  },
  errors: {
    engineRejected: 'The audio engine library rejected the operation (code {code}).',
    memoryLimit: {
      'live-schedule':
        'Playback needs about {required} MiB of working memory, exceeding the {budget} MiB browser budget. Shorten or remove some audio clips so playback fits in memory.',
      'audio-export':
        'Audio export needs about {required} MiB of working memory, exceeding the {budget} MiB browser budget. Shorten the range, lower the sample rate, or export fewer pages.',
      'audio-encoding':
        'Audio encoding needs about {required} MiB of working memory, exceeding the {budget} MiB browser budget. Shorten the range, lower the sample rate, or export fewer pages.',
      'score-export':
        'Score export needs about {required} MiB of working memory, exceeding the {budget} MiB browser budget. Export fewer pages or a shorter range.',
      transcription:
        'Transcription needs about {required} MiB of working memory, exceeding the {budget} MiB browser budget. Transcribe a shorter section of the audio.',
    },
  },
  trackLaneOverflow:
    '{count} track(s) beyond the {limit}-track limit have no mixer lane and stay silent. Delete tracks to bring the project under the limit.',
  webMidiConnectFailed: 'Could not connect to Web MIDI: {detail}',
  gsSetupUnapplied:
    '{count} GS/SysEx setup message(s) were not applied to the playback synth. Only complete setup messages of up to {limit} bytes at the start of the song, before the first note, are applied; they are kept for MIDI export.',
  recording: {
    engineNotStarted: 'Start the engine before recording.',
    micDisconnected: 'The microphone was disconnected. Reconnect a device and request it again.',
    inputProcessorCrashed:
      'The voice changer or pitch correction crashed and was stopped. Request the microphone again to resume.',
    armedTrackLocked: 'Cannot change the armed track while recording.',
    unknownTrack: 'Unknown track id: {id}',
    unknownSource: 'Unknown recording source: {source}',
    audioTrackRequired: 'Recording requires an audio track.',
    midiTrackRequired: 'MIDI recording requires a MIDI track.',
    armAudioTrack: 'Arm an audio track before recording.',
    armMidiTrack: 'Arm a MIDI track before recording.',
    voiceChangerNextBinding: 'Voice changer changes will apply to the next microphone binding.',
    voiceChangerBusy: 'Cannot change the voice changer during a recording operation.',
    retuneNextBinding: 'Retune changes will apply to the next microphone binding.',
    retuneBusy: 'Cannot change retune during a recording operation.',
    sourceNextTake: 'Recording source changes will apply to the next take.',
    deviceNextTake: 'Input device changes will apply to the next take.',
    multiDeviceEffectsUnavailable:
      'Voice changer and retune are unavailable for multiple recording devices; record with a single or aggregate device to enable them.',
    punchOrder: 'The punch-out locator must be after the punch-in locator.',
    transportRejected: 'The engine rejected the transport play command.',
    inputChangedBeforeStop:
      'Recording input changed before the take could be stopped. The take was discarded.',
    inputChangedBeforeSave:
      'Recording input changed before the take could be saved. The take was discarded.',
    overflow: 'Recording reached the capture buffer limit; the end of the take was dropped.',
    storeFailed: 'Failed to store the recording: {detail}',
    storeFailedCleanup:
      'Failed to store the recording: {detail}; cleanup also failed: {cleanupDetail}',
  },
} as const;

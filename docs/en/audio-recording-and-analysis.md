# Recording and analysing audio

Audio enters a project by import or by recording from the microphone. This page covers both, aligning one take to another, transcribing audio to MIDI, splitting a clip into stems, and editing audio in the sample editor. Exporting the result is on [Files and formats](files-and-formats.md); mixing it is on [Mixing and mastering](mixing-and-mastering.md).

## Import audio

1. Open the **Media** tab of the editor dock.
2. Choose audio files with **Import files…**. Each file becomes a row in the asset list, and several files can be chosen at once.
3. Press **Add** on a row. The asset is placed at the playhead as a clip on a new audio track named after the file, and the clip shows its waveform.

## Record from the microphone

1. Add a track with **+ Track**, then **+ Audio track**.
2. Press **Play**. Pressing Play starts the audio engine, and recording is available once the engine has started.
3. Arm the track with the record-arm button in its track header.
4. Press **Record** in the transport bar.
5. Press **Record** again to stop. The take lands in the timeline as a new audio clip.

The [shortcuts page](shortcuts.md) lists the Record key.

## Align a take to a reference

1. Place two audio clips at the same start: a reference and an alternate take. The reference must cover the whole take.
2. Right-click the take clip in the arrangement and choose **Align timing to**.
3. Choose the reference clip in the submenu.

The take clip is warped to follow the reference's timing. Undo turns the warp off again. The menu item is unavailable when no other audio clip covers the whole clip.

## Transcribe audio to MIDI

1. Select an audio clip. In the **Audio clip** group of the arrangement toolbar, press **To MIDI**.
2. In the **Transcribe audio to MIDI** dialog, choose a mode. **Melody** follows one prominent line. **Polyphonic** keeps notes that overlap in a chord.
3. Press **Transcribe**. The button reads **Transcribing…** while the work runs, and the first button in the dialog footer reads **Cancel**.

On completion the dialog closes and a new track with a MIDI clip appears. A clip holding a C4, E4 and G4 chord yields one note in Melody mode and three overlapping notes in Polyphonic mode, with pitches 60, 64 and 67. A clip that plays C4, E4 and G4 one after another yields those three notes in Melody mode.

One Undo removes the new track, clip and notes together. Closing the dialog before starting, or cancelling a running transcription, leaves the project's clips, tracks and notes unchanged.

### Turn the result into a part

The transcribed clip is an ordinary MIDI clip:

- Open it in the **Piano Roll** tab, select a note, press `Delete`, and draw a replacement with the draw tool. The other notes stay as transcribed.
- Choose a built-in synth preset with the instrument button in the device rack.
- Mute the source audio track with the mute button in its track header, then press **Play** to audition the part.
- Save with **File** > **Save As…**. After a reload, the project opened from the start screen keeps the corrected notes, the preset and the mute.

[Files and formats](files-and-formats.md) covers exporting the part as a Standard MIDI File or a WAV mixdown.

## Split stems

1. Select an audio clip.
2. Press **Split stems** in the arrangement toolbar and choose **Harmonic / percussive / residual**.

Split stems produces three new tracks, each holding one clip: harmonic, percussive and residual. Each stem has the same length as the source clip, and none is silent. Added together, the three stems give back the source clip. Rendering the project plays the source and all three stems audibly.

## Edit audio in the sample editor

1. Select an audio clip and open the **Sample** tab. The editor shows the clip's waveform.
2. Open the **Edit** sub-tab and press **Reverse**, or press **Apply** in the **Normalize** group.
3. Each operation adds an entry to the editor's version history, and the asset name shows `(edited)`.

After **Reverse**, a prompt asks whether to use the edited audio for the selected clip. **Cancel** leaves the project's audio unchanged. **Use in project** in the editor toolbar replaces the clip's audio with the edited version and changes the rendered audio. The project's **Undo** restores the original clip.

`Cmd/Ctrl+Z` with focus in the waveform steps back through the sample editor's own history and does not touch the project.

## Adjust clip gain and fades

Select an audio clip in the arrangement. The clip inspector shows **Gain** in decibels and **Fade in** and **Fade out** in beats. Type a value and press `Tab` to apply it; a gain of -6 dB sets the clip's linear gain to about 0.5. Three presses of Undo restore the gain and both fades.

The settings apply to exported audio: the fades attenuate the clip's edges in the mixdown, and a reversed clip renders reversed.

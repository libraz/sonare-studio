# Files and formats

Projects stay in the browser's storage until they are exported as ordinary files. This page covers saving and reopening projects, the portable `.szd` file, Standard MIDI File and MIDI 2.0 clip files, DAWproject, MusicXML, and WAV mixdown and stems. Importing and recording audio is on [Recording and analysing audio](audio-recording-and-analysis.md).

## Save and reopen a project

1. Open **File** > **Save As…**, enter a name and confirm.
2. The unsaved-changes marker next to the project name clears when the save finishes. **File** > **Save** writes to the same name afterwards.
3. After a reload, the start screen lists the saved projects by name next to **Continue last session**. Click a project's name to open it.

A reopened project has the same tracks, clips, instruments, chords and notes as when it was saved, and renders the same audio. Its Undo history starts empty. [Offline use and settings](offline-and-settings.md) covers named revisions.

## The `.szd` file

**File** > **Export .szd** downloads the project as a portable ZIP archive. The archive bundles the project document, its metadata, the audio the project uses and the SoundFonts it uses.

Open the file from the start screen with **Open .szd file…**. The imported project has the same tracks, instruments and clips as the exported one and renders the same audio, and edits to it undo normally.

## Standard MIDI File and MIDI 2.0 clip files

Import a Standard MIDI File or a MIDI 2.0 clip file from the start screen with **Import MIDI file…** or with **File** > **Import MIDI...**. The app tells the two formats apart by the file's header, not its extension. The project stores note velocities and controller values at MIDI 1.0 resolution, so a MIDI 2.0 clip file's 16-bit velocities and 32-bit controller values are reduced to 7 bits on import. Each part that carries notes becomes a track, and the drum channel gets a drum kit. Notes added afterwards keep the channel of the track they are drawn on: melody notes stay on their channel and drum hits stay on channel 10. **Estimate progression** in the Chords list of the **Lists** tab reads the imported parts without the drums distorting the result.

- **File** > **Export SMF** downloads a Standard MIDI File with the extension `.mid`.
- **File** > **Export MIDI 2.0 clip file** downloads a MIDI 2.0 clip file with the extension `.midi2`.

A Standard MIDI File cannot hold audio. When the project has an audio track, **Export SMF** first lists what it will omit, including the audio track by name, and waits for confirmation. After confirmation the file holds the clip's notes with pitches and timings within one tick of the clip.

## DAWproject

- **File** > **Export DAWproject** downloads a `.dawproject` ZIP archive with a project document and a metadata entry. The archive holds every track and clip, embeds the project's audio as WAV files, and keeps MIDI notes including drum notes on channel 10.
- **File** > **Import DAWproject…** opens a `.dawproject` file. The import replaces the open project; when the open project has unsaved changes, the app asks before discarding them.

Importing an exported archive restores the same tracks and clips at the same positions and lengths, the same chord ranges and the same MIDI notes, and the audio tracks render audibly. Exporting the imported project again produces the same tracks, clips and notes.

## MusicXML

- **File** > **Export clip as MusicXML…** writes the active clip as a `.musicxml` score with one pitched note for each note in the clip.
- **File** > **Export clip as compressed MusicXML (.mxl)…** writes the same score as a compressed `.mxl` archive. Its first entry is the uncompressed `mimetype`, and its container file names the archived score.
- **File** > **Import MusicXML…** opens either format. The import replaces the open project, and the app asks before discarding unsaved changes.

An imported file brings its notes back with the same pitches, positions and lengths.

## Audio mixdown and stems

**File** > **Export Audio…** opens the **Export audio** dialog.

- **Range** is the whole project or the **Loop region**.
- **Bit depth** for WAV includes **32-bit float**.
- **Apply master inserts, EQ and mastering chain** includes the master bus in the render. With the chain on, the output differs from the dry mix, and its peak stays at or below the ceiling set in the **Mastering** tab. The chain output is identical after the project is saved and reopened.
- **Release tail** adds seconds after the last clip. With the tail at 0 and the whole project selected, the file's duration matches the project length.
- **Format** is WAV, **FLAC (lossless)** or **MP3 (CBR)**. A FLAC file decodes to the same samples as the WAV of the same render. An MP3 file has the WAV's duration, within the codec's start delay and end padding, and its peak and loudness.
- **Mode** is **Mixdown** or **Stems**.

Press **Export**. When the render finishes, the dialog shows a loudness report with the peak level, and the file downloads in the chosen format.

In **Stems** mode the download is a ZIP with one WAV for each track, named after the track. The stems share the mixdown's sample rate and length, carry each strip's fader and pan, and sum to the mixdown. **Include final master stem** and **Include bus / return stems** are separate toggles; with both off, the archive holds one WAV for each track and nothing else.

A render of a long project can exceed what the mastering chain can process at once. The dialog then stops before rendering, offers no download, and tells you to choose a shorter range or turn off the master chain.

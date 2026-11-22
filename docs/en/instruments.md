# Instruments

Every MIDI track has one instrument, set in the device rack. The instrument is a built-in synth preset or a SoundFont (SF2). Imported drum parts get a drum kit, and project templates assign a sound per track. This page covers choosing and changing those sounds. Notes are in [Editing notes](editing-notes.md), and insert effects on the same rack are in [Mixing and mastering](mixing-and-mastering.md).

## Change a track's instrument

1. Click a MIDI clip in the arrangement so its track is active.
2. Press **Devices** in the app bar to open the device rack.
3. Press the instrument button of the rack. The instrument picker lists the synth presets.
4. Click another preset.

The track plays the new preset at once. MIDI is rendered live by the engine, so the change does not trigger an audio re-render and the clip schedule stays as it was. Two presets produce different audio for the same notes.

## Use a SoundFont

1. In the instrument picker, open the **SF2** tab.
2. Choose a stored font from the list, or press **Load .sf2…** and pick a file.
3. Optionally set **Gain**.
4. Press **Use SoundFont**.

The track's instrument becomes the SoundFont. Choosing it is an ordinary project edit: Undo returns the track to its previous instrument and Redo restores the SoundFont.

### GS effects

A MIDI file can carry GS EFX SysEx messages. Before pressing **Use SoundFont**, the **GS EFX rendering** selector in the SF2 tab chooses **Modern** or **Classic** for them.

The same notes render audibly differently without GS messages, with Modern and with Classic. The choice is saved with the instrument and shows again when the picker is reopened.

## Drum kits

Import a MIDI file with **Import MIDI file...** on the start screen. A part on MIDI channel 10 becomes a track with a drum kit instrument. Notes added to that track in the piano roll stay on channel 10.

## Start from an organ template

**New project > Baroque organ** creates 64 bars in D harmonic minor at 80 BPM, with six sections and four voice tracks. Each track uses the church organ preset and has a bounded pitch range.

Generating parts into these tracks, through **Generate > Generate tracks…**, writes into the existing tracks and leaves their instrument and the track count unchanged. The part list has no drums selected by default in a project without chords. The four voices play audibly in a one-bar preview. Generation is covered in [Composing](composing.md).

## Move a project with its sounds

**File > Export .szd** writes the project together with its audio and the SoundFonts it uses. Open the file from **Open .szd file...** on the start screen, including in a fresh browser context that holds neither the audio nor the font. The reopened project has the same tracks, clips and instruments, and renders the same audio. Edits to it undo as in any other project.

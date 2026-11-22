# Editing notes

The editor dock edits the notes of the active MIDI clip. It has two note editors: the **Piano Roll** tab and the **Steps** tab. This page covers drawing notes, marking them with playing techniques, expression maps, groove and the two ways of entering notes from a keyboard or a pattern grid. Clips and tracks are in [Arranging](arranging.md), and the sounds that play the notes are in [Instruments](instruments.md).

## Draw notes in the piano roll

1. Select a MIDI clip in the arrangement and open the **Piano Roll** tab.
2. Double-click an empty cell to create a note, or pick the **Draw** tool in the tool palette and click a cell.
3. Press `Mod+Z` to undo the note.

Click a track's chip in the legend above the grid to edit that track instead. A note drawn on an imported melody part keeps that part's MIDI channel.

A drum track behaves differently:

- New notes stay on MIDI channel 10.
- **Scale** snap is disabled.
- **Row tint**, the harmonic shading of the pitch rows under **View**, does not paint the drum editor.

## Mark notes with a playing technique

The **Decorate** menu in the piano roll toolbar opens the **Decorate clip** panel.

1. Choose a technique: **Ghost**, **Flam**, **Drag**, **Slide** or **Accent**.
2. Set **Amount**. The preview line reads `Marks N of M notes` and shows how many notes the technique can sit on.
3. Press **Apply**.

Decorating only adds marks. No note moves or changes length, and one `Mod+Z` removes every mark.

## Map marks to key switches

An expression map turns the marks of a track into key switches for the instrument.

1. Right-click the track header.
2. Choose **Key switches C1-D#1** from the expression map entries. The menu then shows it as selected.
3. Choose **Off (display only)** to remove the map.

With the map on, the rendered audio differs from the render without it, because the marked notes send key switches. Turning the map off restores the original render exactly.

## Copy a groove

A groove is the timing feel of one clip, applied to the onsets of another. Applying a groove moves the target's onsets and never edits the source.

From the arrangement:

1. Right-click the source clip and choose **Capture groove from clip**.
2. Right-click the target clip and choose **Apply groove to clip**.

From the piano roll, select notes, right-click a note, open the **Quantize** submenu and use **Capture groove from selection**, **Apply groove** and **Clear captured groove**. **Apply groove** is disabled once the captured groove is cleared.

`Mod+Z` takes an applied groove back to the straight onsets.

## Enter notes from the keyboard

1. Turn on **Music typing** in the piano roll toolbar. On its own it writes nothing.
2. Turn on **Step input**. A step cursor appears, and typed notes are written at the cursor.

Each note is as long as one grid step, and the cursor moves forward one step after it.

| Key         | Effect                                                                             |
| ----------- | ---------------------------------------------------------------------------------- |
| `Tab`       | Rest: skip one step                                                                |
| `Shift+Tab` | Step the cursor back one step, so the next note lands on the previous note's start |
| `Z`         | Octave down                                                                        |

The note keys and the other music typing keys are listed in [Keyboard shortcuts](shortcuts.md#music-typing-fixed-not-remappable). With both toggles off, typed keys write nothing.

## Build a pattern in the step sequencer

1. Open the **Steps** tab.
2. Click cells in a row to switch steps on.
3. Press **Apply to clip**.

Each active step becomes a note in the active clip. The pattern plays on the next playback without an audio re-render, so it is audible from the engine's instruments straight away.

## Look up a key

Press `?` to open the **Keyboard shortcuts** dialog. `Escape` closes it, and focus returns to where it was. The same list is on the [keyboard shortcuts](shortcuts.md) page.

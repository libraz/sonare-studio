# Arranging

The arrangement is the multi-track timeline above the editor dock. It holds MIDI and audio clips, a section lane, a chord track and the project tempo map. This page covers building a song on it: tracks, clips, sections, chords and the workspace layout. Note-level work is in [Editing notes](editing-notes.md), and levels and routing are in [Mixing and mastering](mixing-and-mastering.md).

## Add a track and a clip

1. Press **+ Track** in the track header column and choose **+ MIDI track**. A new header appears below the existing ones.
2. Double-click the empty lane of the new track. A one-bar clip is created where you clicked.

Double-click is also the gesture for creating a note in the piano roll; see [Keyboard shortcuts](shortcuts.md#pointer-gestures).

## Add audio to the timeline

1. Open the **Media** tab in the editor dock and import an audio file.
2. Press **Add** on its row. The asset is placed as a clip at the playhead.

Move the playhead to the start of the project first to place the clip on bar one.

## Move, trim, split and crossfade audio clips

Select an audio clip by clicking it; the clip inspector follows the selection.

- **Move.** Drag the clip body. The start snaps to the grid.
- **Trim.** Drag the right edge. The end snaps to the grid and the start stays put.
- **Split.** Right-click inside the clip and choose **Split here**. The two pieces are contiguous.
- **Crossfade.** Right-click one of two touching pieces and choose **Crossfade with next clip**. The left clip gains a fade-out and the right clip a fade-in. The entry is available for touching clips that have unused source audio left to overlap.

Each of these is one undo step. Press `Mod+Z` and `Mod+Shift+Z` to step back and forward.

## Set clip gain and fades

The clip inspector of an audio clip has three fields: **Gain** in decibels, **Fade in** and **Fade out** in beats. Each edit is its own undo step, so three edits take three `Mod+Z` presses to undo.

## Copy, cut and paste clips

Select a clip, then use **Edit > Copy selection** or **Edit > Cut selection**.

- **Edit > Paste at playhead** places the clip at the playhead.
- Right-click an empty stretch of a lane and choose **Paste** to place the clip there. The position snaps to a bar boundary.

## Work with sections

The section lane sits above the tracks.

- Double-click the lane to add a section band.
- Right-click a band and choose **Duplicate section** to repeat a four-bar section. Every MIDI and audio clip and every chord change inside it reappears four bars later, and one undo removes the whole copy.
- Right-click a band and choose **Regenerate drums for this section** to rewrite only that range of a drum track. The panel opens with the section's start bar and length filled in. Notes outside the range stay as they were, and **Reroll** gives another variation of the same range; see [Composing](composing.md).

The **J-pop** project template starts from a 96-bar form with eight sections at 120 BPM. Create it from **New project** on the start screen.

## Estimate the chord track

Open the **Lists** tab, choose **Chords** and press **Estimate progression**. The chords are inferred from the notes of all tracks. Drum tracks do not distort the result: an imported four-part song estimates as C, F, G, C.

Generated progressions land on the same chord track and are described in [Composing](composing.md). The chord track also follows a duplicated section.

## Place and edit markers

1. Right-click the ruler at the position you want and choose **Add marker here…**.
2. Type a name in the prompt and press **Add**.

The marker is stored in the project at the clicked position. Open the **Lists** tab and choose **Markers** to edit it:

- Change the **Name** field of its row to rename it.
- Change the **Position** field to move it. Positions are written as bars.beats, so `5.1` is the first beat of bar 5.
- Press the seek button at the start of the row to move the playhead onto the marker.
- Press the delete button at the end of the row to remove it.

## Change the time signature

1. Open the **Lists** tab and choose **Time Sig**.
2. Set **Beats** of the first row to the number of beats per bar.
3. Press **Apply**.

With **Beats** set to 3 the meter is 3/4. A bar is three beats long, bar 2 starts after three beats, and the **Insert time…** prompt of the ruler menu offers a three-beat default length. The playhead position field refuses beat 4 of a bar. One **Undo** restores the previous meter.

## Edit the tempo map

1. Open the **Lists** tab and choose **Tempo**.
2. Press **Add tempo** to add a row.
3. Set **Position** and **BPM** of the new row, then press **Apply**.

An entry at position `1.3` with **BPM** 60 halves the tempo from the third beat. The playhead then advances at the new rate, and the rendered audio of a four-beat range that crosses the entry lasts one second longer. One **Undo** restores the previous tempo map.

## Make audio follow the tempo

1. Select an audio clip and open the **Sample** tab.
2. In the **Warp** row, press **Follow tempo**.
3. Change the project tempo in the **Tempo** field of the transport bar.

With **Follow tempo** on, the beats of the clip stay on the beat grid after the tempo changes. Press **Follow tempo** again to turn it off: the clip then plays at its recorded rate and its beats leave the grid.

## Freeze a track and bounce it in place

Press **More actions** on a track header to open its panel, then press the snowflake toggle to freeze the track. The track is baked to audio and the master level does not change.

A frozen track refuses edits. **Split here** in its clip menu is disabled, and `Delete` leaves the selected clip in place.

Right-click the header and choose **Unfreeze** to bring the live render back at the same level.

To bounce, turn on the loop region, right-click the header and choose **Bounce in place**. The loop region is rendered onto a new track, and the original track keeps playing. Over the loop region the two tracks sound together, about 6 dB louder than the original alone.

## Mute during playback

Open the **Mixer** tab and press **Mute** on every strip while the project plays. The master output goes silent at once, without stopping playback.

## Switch the workspace layout

Open **Options > Settings > Layouts** and press a preset.

- **Mix** activates the **Mixer** tab and closes the device rack.
- **Compose** activates the **Piano Roll** tab and opens the device rack.

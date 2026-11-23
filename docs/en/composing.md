# Composing

The **Generate** menu writes a chord progression and then parts over it: motif, drums, bass, counter melody and chord backing. The piano roll and the chord list then help to place and reharmonize notes, and a note's theory card explains what it does against the current chord. Undo, redo and the other keys are on the [keyboard shortcuts](shortcuts.md) page.

## Generate a chord progression

1. Open **Generate** and choose **Generate chord progression…**.
2. Set **Bars** and click **Generate**.

A new progression in an empty project is four bars long. To extend it, open the dialog again, choose **Append** under **Chord track**, enter the number of extra bars and generate. Generating 64 bars and appending 32 gives a 96-bar progression.

The completed dialog offers **Generate tracks next…**.

## Generate parts

1. Open **Generate** and choose **Generate tracks…**. Without a progression, the dialog says **No chord progression yet** and offers **Generate chord progression…**.
2. The part list shows **Motif**, **Drums**, **Bass**, **Counter melody** and **Backing**. **Drums**, **Bass** and **Backing** are ticked at first. The **All** chip ticks every available part.
3. Click **Generate N tracks**. Each ticked part becomes one track.

Drum notes are written on the percussion channel.

The **Counter melody** part is unavailable until a MIDI clip with notes exists to follow.

Each part has a target menu. **New track** adds a track; **Replace: name** writes into an existing track in place and leaves the track list unchanged.

## Add a lead melody

The completed generation dialog has **Compose lead melody**. It adds a MIDI track named **Lead** with a clip as long as the progression and opens that clip in the piano roll. The track stays the lead target when you rename it, so a second request reuses it.

Draw the melody with the pencil. Ghost notes of the accompaniment do not take over the editor: a click on a ghost note writes a note into the lead clip.

Once the lead holds notes, **Generate tracks…** offers **Counter melody**. With only that part ticked, the button reads **Generate 1 track**.

## Start from a template

Choose **J-pop** or **Baroque organ** in the **New project** dialog.

**J-pop** is a 96-bar song at 120 BPM with eight sections and the tracks **Drums**, **Bass**, **Backing** and **Lead**. Generate a 96-bar progression, open **Generate tracks…**, set the target of **Drums**, **Bass** and **Backing** to **Replace** and generate. The template tracks fill in place.

### Regenerate one section's drums

1. Press `Mod+Shift+F` to fit the project, so the section bands are visible.
2. Right-click the second **Pre-chorus** band and choose **Regenerate drums for this section**.
3. The panel opens with **Start bar** 65 and **Length (bars)** 8, and with **Pre-chorus** and **Chorus** as the section and next section.
4. Click **Generate**.

The drums change in bars 65 to 72 only. All other drum bars and every other part stay as they were, and the new drum notes stay on the percussion channel.

To try another variation of the same section, open the panel again, click **Reroll** and generate. **Undo** and **Redo** step between the variations.

### Write a four-voice organ piece

The **Baroque organ** template is 64 bars at 80 BPM in D harmonic minor, with six sections and four church-organ tracks: **Manual I Soprano**, **Manual I Alto**, **Manual II Tenor** and **Pedal Bass**. The project has no chords, so **Drums** is not ticked in **Generate tracks…**.

1. Tick only **Motif**, set its target to **Replace: Manual I Soprano**, set its length in **Details** to 64 bars and generate. The track list and the organ sound do not change.
2. Select the soprano track. In **Generate tracks…**, tick only **Counter melody** and set its target to the alto track.
3. Do the same for the tenor track. **Reroll** in the part's **Details** gives another variation.
4. Generate a 64-bar chord progression, continue to the tracks, tick only **Bass** and set its target to **Pedal Bass**.

The finished piece is three minutes and twelve seconds long. **Reroll** on the motif changes the soprano and leaves the other three voices as they are.

## Repeat a generation with a project seed

1. Open **Generate chord progression…** or **Generate tracks…**.
2. Enter a number in **Project seed**, then generate.

The seed is saved in the project. Generating twice with the same seed writes the same chords and the same notes in **Motif**, **Drums**, **Bass** and **Backing**. A different seed writes a different progression and different notes in at least one of those parts.

## Reroll a part

**Reroll** in a part's options asks for another variation of that part. Regenerating one part leaves the other parts unchanged.

## Read the theory card

Hover a note in the **Piano Roll** tab. A card explains the note against the current chord and key, with lines such as **Safety**. Move the pointer onto the card's info button and click it to open the glossary entry. The card stays on the same note while the pointer travels there.

To see counterpoint guidance, open **Guide** in the piano roll toolbar and set **Profile** to **Counterpoint**. A note in an organ voice then gets a **Counterpoint** line on its card.

## See the placement guide

Open **View** in the piano roll toolbar and turn **Placement** on. With the draw tool, the column the pointer is in is tinted per pitch by how that pitch sits against the other parts, so a pitch that clashes looks different from one that fits.

An accompaniment track can follow the melody: right-click its track header, choose **Follow melody** and pick the melody track. Placing a melody note that clashes with an accompaniment note then removes that accompaniment note, in the same undo step as the placement. One **Undo** restores both notes.

Turning **Placement** off clears the tinted column.

## Reharmonize with a secondary dominant

1. Open the **Lists** tab and select **Chords**.
2. Click **Insert secondary dominant before chord G** in the row of a G chord.

In a C, F, G, C progression the bar of F is split and the list reads C, F, D7, G, C. The new chord is labelled **V7/V**.

A held note that crosses the new chord boundary, for example an F, gets a different **Safety** line on its theory card. The line mentions the chord change, and the note's stripe in the piano roll turns amber. **Undo** restores the card and the stripe without moving the pointer.

## Repeat a generated section

1. Double-click the section lane to create a section over the generated material.
2. Right-click the section band and choose **Duplicate section**.

Every track's clips in the section, including a reference audio clip, are copied one section length later, together with the chord changes. **Undo** removes clips and chords together and **Redo** brings them back.

See [Arranging](arranging.md) for sections and [Editing notes](editing-notes.md) for the piano roll.

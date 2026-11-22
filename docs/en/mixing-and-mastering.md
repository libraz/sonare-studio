# Mixing and mastering

The **Mixer** dock tab holds a strip for every track, the VCA strips and the master strip. The device rack holds a track's inserts, and the **Mastering** dock tab holds the project's mastering chain. Undo, redo and transport keys are on the [keyboard shortcuts](shortcuts.md) page.

## Open the mixer

Select the **Mixer** dock tab. It shows one channel strip per track plus the master strip.

The mute button on a strip silences that track only. Every other strip keeps its level reading.

## Set gain and mute

Click a strip's gain readout, type a value in dB and press Enter. Click the mute button to toggle mute.

## Store and recall snapshots

The mixer panel has snapshot slots, each labelled with a letter.

1. Set the gain and mute state of the strips.
2. Click the store button (⤓) of a slot. The slot now holds the current mix.
3. Click the slot's letter to recall it. Gain and mute return to the stored values.

A recall is one undo step: **Undo** in the header returns the mix to what it was before the recall.

Storing into a slot that already holds a mix opens **Replace mixer snapshot?**. **Cancel** keeps the stored mix.

## Group faders with a VCA

1. Right-click a track header and choose **New VCA group**. The group is created and the track is assigned to it.
2. Open the **Mixer** tab. The group has a VCA strip with its own fader.
3. Focus the fader and press the arrow keys. Each **Down** press lowers the group by 1 dB.

The assigned track plays as many dB lower as the VCA fader says. Tracks outside the group do not change.

Removing a track does not remove the group. Remove the group with the remove button on its VCA strip.

## Add and bypass inserts

Open the device rack with **Devices** in the app bar.

- **+ Add insert…** opens a list of processors. Choosing one adds it to the track's chain.
- The power button on an insert row bypasses the insert and enables it again.

Both changes apply to the running engine at once, without rebuilding the arrangement.

## Shape a guitar DI

With a recorded guitar track selected, click **Add Guitar Amp** in the device rack. The amp editor opens on the Clean Combo rig, and the track now sounds different from the dry recording.

- Choose another amp preset, for example **Modern Lead**. The rendered audio changes, and the **Drive**, **Bass** and **Middle** controls and the amp model show that preset's values.
- The editor's bypass button switches the amp off and the insert row's power button follows it. A bypassed amp renders the dry recording.
- Click the name of an insert row to open that amp's controls when a track has more than one.

Undo steps back through a preset change and a bypass.

## Record fader automation

Each strip has **R** (read), **T** (touch) and **L** (latch) buttons.

1. Press **L** on a strip.
2. Start playback and drag the strip's fader.
3. Stop playback.

The drag is recorded as an automation lane with several points. Stopping returns the strip to **R**, and the next pass follows the recorded curve.

**T** works on device-rack controls in the same way. With **T** on, dragging an amp Quick Control knob or moving a slider in the amp editor records a breakpoint on that parameter's lane instead of writing a fixed value.

## Get a starting mix

1. Open the **Mixer** tab, open **Templates**, and choose **Suggest a mix…**.
2. The **Suggest a mix** dialog renders each track and lists the measured tracks.
3. Click **Apply suggestion**.

One undo restores the mixer to its state before the suggestion. A fader that is turned down does not hide a track from the measurement, and an amp insert already on a track stays in place and stays audible.

## Master

Open the **Mastering** dock tab. The signal path summary shows a **Live** path and the **Preset → all enabled rack processors** path used for rendering.

### Choose a preset and set loudness

1. Open the preset menu and choose a preset, for example **Streaming**. **No preset** clears it.
2. Edit the preset's controls: **Target LUFS**, **True peak ceiling**, **Denoise enabled** and **Denoise reduction**.

**Denoise reduction** stays disabled while **Denoise enabled** is off. Turning denoise on changes the rendered audio, and resetting **Denoise enabled** restores the preset's rendering.

Typed values stay when you switch to another dock tab and back. The reset button next to a control returns it to the preset value; for **Streaming**, the target resets to -14 LUFS.

**Auto-suggest** starts from the selected preset and shows it as the base of its result.

### Build a chain

1. Click **+ Processor**.
2. The catalog marks each processor **Live** (runs during playback, for example **Brickwall Limiter**) or **Render** (for example **Declick**).
3. Choose processors such as **Brickwall Limiter** and **Tape**. Each is added to the chain.

A chain changes the rendered mixdown compared with the same project rendered without it.

### Compare with A/B preview

1. Click **Preview**. The project renders with the chain (A) and without it (B).
2. **Level match** is on by default and shows the monitor attenuation as `A -x.x dB · B -y.y dB`. Turn it off and it reads **Off**; turn it on again and the measured attenuation returns.
3. Click **Play**. Click **B** while it plays to hear the bypassed version. Playback continues from the same position and the two versions stay in sync.
4. Click **Stop** to end the preview.

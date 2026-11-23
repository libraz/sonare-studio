# Introduction

sonare studio is a sample application for [libsonare](https://github.com/libraz/libsonare). It drives libsonare's WebAssembly build end to end through a browser UI, and its end-to-end scenarios are the integration test bed for that build. There is no server and nothing is uploaded: the audio engine, the project model, the offline renderer and every export run inside the tab. Projects are stored in the browser's origin-private file system and leave it as ordinary files.

![Schematic of the shell: menu bar, arrangement over a tabbed editor dock, device rack alongside, transport bar at the bottom](../images/shell-layout.svg)

## Status

sonare studio is a sample application, not a supported production DAW. It is pre-1.0 experimental software with no warranty, and the code has not been independently reviewed or audited.

A project file (`.szd`) carries a schema version. A file from an earlier schema version is upgraded on open; one from a newer version is refused. There is no compatibility promise across libsonare major versions.

## Built on

- **[libsonare](https://github.com/libraz/libsonare)** is the audio side: a C++17 core compiled to WebAssembly, published as `@libraz/libsonare`. It owns the project model, the DSP, the mastering chain, the analysis and the offline renderer.
- **[libcantus](https://github.com/libraz/libcantus)** is the theory side: a dependency-free TypeScript library, published as `@libraz/libcantus`. It does chord spelling, key and form analysis, counterpoint rules, voicing and part generation. `src/compose/` adapts its results to the project model and to the wording the UI shows. None of it goes through wasm.
- **Verovio** engraves the score, and **Vue 3** with **Pinia** drives the UI.

How the pieces fit together is on the [architecture](architecture.md) page.

## Related projects

- **[libsonare-mcp](https://github.com/libraz/libsonare-mcp)** is an MCP server that lets an AI assistant analyze, edit, master, mix and compose audio and MIDI through libsonare.
- The libsonare documentation site is [libsonare.libraz.net](https://libsonare.libraz.net).

## What it exercises

Each guide page describes what an end-to-end scenario drives through the UI, and grows only where a scenario backs it:

- [Arranging](arranging.md): tracks and clips, sections, markers, the chord track, tempo and meter maps, warp, freeze and bounce.
- [Editing notes](editing-notes.md): the piano roll, playing techniques and expression maps, groove, controller lanes, MIDI FX, step input and the step sequencer.
- [Instruments](instruments.md): synth presets, GM programs and drum kits, SoundFonts and multi-timbral channel maps.
- [Mixing and mastering](mixing-and-mastering.md): strips, snapshots, VCA groups, inserts, automation and the mastering chain.
- [Score](score.md): engraving, annotations, print, PDF and MusicXML.
- [Composing](composing.md): progressions, generated parts, the theory card, the placement guide and reharmonization.
- [Recording and analysing audio](audio-recording-and-analysis.md): import, recording, alignment, transcription, stem separation and the sample editor.
- [Files and formats](files-and-formats.md): `.szd`, MIDI, DAWproject, MusicXML, mixdown and stems.
- [Offline use and settings](offline-and-settings.md): offline use, saving, revisions, language and shortcuts.

The app has more surface than these pages describe. A feature with no scenario behind it is not described here.

## What it does not do

- **Not a supported production DAW.** The app exists to exercise libsonare; there is no stability promise for project files across libsonare major versions.
- **No MPE.** Expression lanes use MIDI 1.0 channels, and polyphonic pressure is stored per pitch rather than per note.
- **No plugin hosting.** Instruments and effects are the ones the engine ships; there is no VST/AU/CLAP bridge.
- **The score is not a notation editor.** It edits notes through a few gestures (add, delete, re-pitch; see [keyboard shortcuts](shortcuts.md)), but there is no note-value, rest or beam entry, and layout is always derived.
- **No accounts, sync or collaboration.** One browser profile, one set of projects.
- **Round-trips are lossy** for DAWproject and MusicXML, by the nature of those formats. The app lists what it is about to drop rather than dropping it quietly.

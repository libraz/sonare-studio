# sonare studio

[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](https://github.com/libraz/sonare-studio/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Platform](https://img.shields.io/badge/platform-browser%20%7C%20WebAssembly-lightgrey)](https://github.com/libraz/sonare-studio)

**sonare studio is a DAW that runs entirely in the browser, with nothing uploaded.** Arrangement, piano roll, mixer, mastering, an engraved score and theory-driven composition all run inside the tab on a WebAssembly audio engine, and projects stay in the browser's own storage until you export them as ordinary files.

🎧 **[Open the app](https://sonare-studio.libraz.net)** &nbsp;·&nbsp; 📖 **[Documentation](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md)** &nbsp;·&nbsp; **[Getting started](https://github.com/libraz/sonare-studio/blob/main/docs/en/getting-started.md)** &nbsp;·&nbsp; **[Keyboard shortcuts](https://github.com/libraz/sonare-studio/blob/main/docs/en/shortcuts.md)**

> Pre-1.0 and experimental, with no warranty: the `.szd` project format can still change between releases, and the code has not been independently audited.

![Schematic of the shell: menu bar, arrangement over a tabbed editor dock, device rack alongside, transport bar at the bottom](docs/images/shell-layout.svg)

## What it does

- **Arrange** — multi-track MIDI and audio timeline with sections, markers, a chord lane, a tempo/meter map, warp and freeze. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Edit notes** — piano roll with controller lanes, ornaments, MIDI FX, expression maps, groove, step input and a step sequencer. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Play sound** — built-in synths, GM/GS programs and drum kits, SoundFont (SF2) playback and multi-timbral setups. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Mix and master** — channel, bus and VCA strips with inserts, sends, automation and metering, and a mastering chain with loudness targets. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Read the score** — the active clip engraved with Verovio, with chord symbols, print and PDF; the app's own notation layer reads and writes MusicXML and `.mxl`. [Architecture](https://github.com/libraz/sonare-studio/blob/main/docs/en/architecture.md#notation-is-derived-never-authored)
- **Compose** — chord progressions and generated parts from one reproducible seed, reharmonization, and note-by-note theory guidance. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Record and analyse audio** — takes and comping, tempo/chord/section analysis, audio-to-MIDI transcription and stem separation. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Move files in and out** — `.szd`, DAWproject, Standard MIDI File, MIDI 2.0 clips, MusicXML, stems, and WAV / FLAC / MP3 mixdown. [What it does](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does)
- **Works offline** — installable PWA, English and Japanese UI, remappable shortcuts, autosave and named revisions. [Keyboard shortcuts](https://github.com/libraz/sonare-studio/blob/main/docs/en/shortcuts.md)

## Getting started

[sonare-studio.libraz.net](https://sonare-studio.libraz.net) serves the hosted build of this repository, so there is nothing to install to use it, and nothing you open there is uploaded. The app needs a current Chromium- or Firefox-based browser. To run it locally you need Node 26 and Yarn 4 (pinned in `mise.toml`):

```sh
yarn install
yarn dev      # dev server with cross-origin-isolation headers; open the printed URL
yarn build    # production build into dist/
```

The start screen offers a new project or the bundled demo. Press **Play** and the audio engine boots on its own. Serving a build is covered in [Deployment](https://github.com/libraz/sonare-studio/blob/main/docs/en/deployment.md).

## Related projects

- **[libsonare](https://github.com/libraz/libsonare)** — the C++17 audio engine compiled to WebAssembly that this app runs on: project model, DSP, mastering, analysis and offline rendering. [Documentation](https://libsonare.libraz.net)
- **[libsonare-mcp](https://github.com/libraz/libsonare-mcp)** — an MCP server that lets an AI assistant analyze, edit, master, mix and compose audio and MIDI through libsonare.
- **[libcantus](https://github.com/libraz/libcantus)** — the TypeScript music-theory library behind the composition and guidance features.

## Documentation

The documentation is plain Markdown under [`docs/`](https://github.com/libraz/sonare-studio/tree/main/docs), in English and Japanese.

- **Learn** — [Introduction](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md) · [Getting started](https://github.com/libraz/sonare-studio/blob/main/docs/en/getting-started.md)
- **Guides** — [Keyboard shortcuts](https://github.com/libraz/sonare-studio/blob/main/docs/en/shortcuts.md) · [Deployment](https://github.com/libraz/sonare-studio/blob/main/docs/en/deployment.md)
- **Reference** — [Architecture](https://github.com/libraz/sonare-studio/blob/main/docs/en/architecture.md) · [Contributing](https://github.com/libraz/sonare-studio/blob/main/CONTRIBUTING.md)

## Non-goals

No MPE, no plugin hosting (VST/AU/CLAP), no notation editor beyond a few note gestures on the score, and no accounts, sync or collaboration. DAWproject and MusicXML round-trips are lossy by the nature of those formats, and the app lists what an export will drop before you confirm. [What it does not do](https://github.com/libraz/sonare-studio/blob/main/docs/en/introduction.md#what-it-does-not-do)

## License

[AGPL-3.0-or-later](LICENSE)

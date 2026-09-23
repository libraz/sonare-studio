# sonare studio

A digital audio workstation that runs entirely in the browser, on the
[libsonare](https://github.com/libraz/libsonare) WebAssembly engine and the
[libcantus](https://github.com/libraz/libcantus) theory library.

[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Platform](https://img.shields.io/badge/platform-browser%20%7C%20WebAssembly-lightgrey)](https://github.com/libraz/sonare-studio)

There is no server and nothing is uploaded. The audio engine, the project model,
the offline renderer and every export run inside the tab. Projects are stored in
the browser's origin-private file system and leave it as ordinary files.

![Schematic of the shell: menu bar, arrangement over a tabbed editor dock, device rack alongside, transport bar at the bottom](docs/assets/shell-layout.svg)

> **Status** — a personal prototype, and experimental software with no warranty.
> It is pre-1.0: the `.szd` project format and the engine ABI can still change
> between commits. The code has not been independently reviewed or audited.

## Built on

**[libsonare](https://github.com/libraz/libsonare)** is the audio side: a C++17
core compiled to WebAssembly that owns the project model, the DSP, the mastering
chain, the analysis and the offline renderer. This repository carries a copy of
its build output under `src/wasm/`, synced with `yarn copy:wasm`.

**[libcantus](https://github.com/libraz/libcantus)** is the theory side: a
dependency-free TypeScript library, published as `@libraz/libcantus`, that does
chord spelling, key and form analysis, counterpoint rules, voicing and part
generation. `src/compose/` adapts its results to the project model and to the
wording the UI shows. None of it goes through wasm.

Verovio engraves the score, and Vue 3 with Pinia drives the UI.

## What it does

**Arrange.** Multi-track timeline with MIDI and audio clips, sections, markers,
a chord lane and a tempo/meter map. Clips split, crossfade, warp and freeze;
sections can be detected from the material and coloured by what recurs.

**Edit notes.** Piano roll with a snap grid, velocity and controller lanes,
ghost notes, ornaments, MIDI FX, expression maps, groove, QWERTY music typing
and step input. A step sequencer covers pattern, Euclidean and randomize work.

**Play sound.** Per-track instruments: built-in synth presets, SoundFont (SF2)
playback, and GM-style multi-timbral setups where channel 10 is the drum kit.
Each track gets an insert chain and quick controls in the device rack.

**Mix and master.** Channel strips with gain, pan, sends, EQ and inserts, plus
bus and VCA strips, mixer snapshots, sidechain keys, solo-safe and per-strip
automation. Metering covers level, gain reduction, spectrum and goniometer on
the master and every strip. The master bus carries a mastering chain — EQ,
multiband dynamics, saturation, stereo tools, a true-peak maximizer — with A/B
preview and streaming-loudness targets.

**Read the score.** The active clip is engraved with Verovio, with chord-symbol
estimation, page layout, print, PDF and MusicXML export. Annotations (dynamics,
articulations, slurs) and an engraving-only transpose apply from the score
panel; the piano roll's Decorate panel places ghosts, flams, drags, slides and
accents across a whole clip where the meter admits them. None of it writes back
to the MIDI — see [Notation is derived](#notation-is-derived-never-authored).

**Compose.** Generate a chord progression by style and preset, or fit one to an
existing melody, then generate parts over it — motif, drums, bass, counter
melody and chord backing, each with its own groove, contour, register and
voicing. One project seed drives the whole arrangement, so a reroll is
reproducible. Reharmonization works diatonically or through secondary and
borrowed chords, and can run reactively as you edit. A guidance card reads the
note under the cursor against the current chord and key: scale degree, chord
tone or tension, cadence arrival, modulation pivot and counterpoint against the
voice below, in beginner, normal or theory wording.

**Record and analyse audio.** Microphone recording with monitoring, count-in,
metronome, punch and cycle recording into takes, then comping across them.
Imported audio can be analysed for tempo, chords and sections, transcribed to a
MIDI clip, or split into harmonic, percussive and residual stems. A sample
editor handles clip content, and the media browser filters assets by key, BPM
and loudness.

**Move files in and out.** `.szd` projects, DAWproject, Standard MIDI File,
MIDI 2.0 clip files, MusicXML, separated stems, and WAV / FLAC / MP3 mixdown
(plus AAC and Opus where the browser provides them). Audio exports can render
per-track, per-bus and master stems, and report loudness and clipping. Where a
format cannot carry something, the dialog lists exactly what will be dropped
before you confirm.

**Live in the app.** Installable as a PWA and usable offline, with `.szd` file
handling from the OS. English and Japanese UI, five note-name systems, light and
dark themes, remappable shortcuts with a `?` cheatsheet, a command palette,
MIDI learn and control-surface bindings, named workspace layouts, a first-run
tour and a keyboard object navigator for the canvas surfaces. Autosave, named
revisions and full backups run against browser storage.

Keyboard reference: [docs/shortcuts.md](docs/shortcuts.md).

## What it does not do

- **No MPE.** Expression lanes use MIDI 1.0 channels, and polyphonic pressure is
  stored per pitch rather than per note.
- **No plugin hosting.** Instruments and effects are the ones the engine ships;
  there is no VST/AU/CLAP bridge.
- **The score is display-only.** You cannot enter or edit music from it.
- **No accounts, sync or collaboration.** One browser profile, one set of
  projects.
- **Round-trips are lossy** for DAWproject and MusicXML, by the nature of those
  formats. The app tells you what it is about to drop rather than dropping it
  quietly.

## Requirements

- A current Chromium- or Firefox-based browser. The app needs AudioWorklet,
  WebAssembly, OPFS, and SharedArrayBuffer where available.
- **Cross-origin isolation.** The dev and preview servers, and the bundled
  `public/_headers`, send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which SharedArrayBuffer
  requires. Without isolation the engine falls back to a postMessage transport
  and still works.
- Node 24 and Yarn 4, pinned in `mise.toml` via [mise](https://mise.jdx.dev).

## Getting started

```sh
yarn install

# Copy the libsonare wasm artifacts. Expects a sibling checkout at ../libsonare
# with bindings/wasm/dist already built.
yarn copy:wasm

yarn dev
```

Open the printed URL. The start screen offers a new project, the bundled demo
(Toccata and Fugue in D minor, BWV 565) or anything already in browser storage.
Press **Play** and the audio engine boots on its own.

## Scripts

| Script | Description |
| --- | --- |
| `yarn dev` | Vite dev server with cross-origin-isolation headers |
| `yarn build` | Worklet bundle, type check, production build |
| `yarn build:worklet` | Build the self-contained AudioWorklet module only |
| `yarn preview` | Serve the production build locally |
| `yarn copy:wasm` | Sync wasm artifacts from `../libsonare` into `src/wasm/` |
| `yarn test` · `yarn test:watch` | Vitest (jsdom) unit and component tests |
| `yarn test:coverage` | The same suite with v8 coverage |
| `yarn test:external-formats` | Validate exported files with external tools |
| `yarn lint` · `yarn lint:fix` | Biome check / autofix |
| `yarn typecheck` | `vue-tsc --noEmit` |
| `yarn verify` | lint, tests, external-format tests, build |

## Architecture

Vue 3 and Pinia drive the UI. The heavy surfaces — arrangement, piano roll,
waveforms — are canvas-2d layers repainted through a requestAnimationFrame
batcher in `src/ui/canvas/`.

![Engine topology: one wasm binary instantiated on the main thread and in the AudioWorklet, with workers and OPFS alongside](docs/assets/engine-topology.svg)

### One wasm binary, two instances

libsonare ships as `sonare.wasm`, copied into `src/wasm/` (generated, read-only)
and instantiated twice from the same bytes.

On the main thread, and in workers for export, it is the project model and the
offline renderer: tracks, clips, notes, tempo, the SMF and MIDI 2.0 codecs.
Inside an AudioWorklet it is the realtime engine: it plays scheduled PCM against
the transport and reports meters and telemetry. Control traffic uses
SharedArrayBuffer when cross-origin isolation is available and degrades to
postMessage otherwise (`src/engine/engine.ts`).

The worklet scope cannot fetch, so the main thread passes the wasm bytes in
through `processorOptions.wasmBinary`. The worklet bundle is content-addressed
(`public/assets/sonare-engine-worklet-<hash>.js`, built by `yarn build:worklet`)
and its URL reaches the app through `.worklet-build/manifest.json`, so a
refreshed engine can never be paired with a stale worklet.

Playback goes through a prerender path. MIDI clips are bounced offline to stereo
PCM with the track's instrument (`src/engine/instruments.ts`, content-keyed
cache) and the audio is scheduled into the realtime engine. Edits re-bounce the
affected clips after a short debounce.

### Every edit goes through the command layer

The wasm `Project` instance is deliberately non-reactive. All edits go through
`src/project/commands.ts`, which keeps a dual-layer undo history — wasm edits
plus app-level metadata snapshots — and refreshes the reactive Pinia mirror that
components read.

### Theory runs beside the engine, not inside it

`src/compose/` is plain TypeScript over libcantus and never touches wasm. It
holds the adapters both directions: project notes and the tempo/meter map go in
as libcantus input, and chords, keys, sections, cadences, counterpoint verdicts
and generated parts come back out as commands and as UI wording. Generation is
seeded per project, so a reroll is reproducible.

### Notation is derived, never authored

The score panel quantizes the active clip's notes into a display-only model
(`src/notation/model.ts`), serializes it to MusicXML and engraves it with
Verovio in a worker. Nothing in that pipeline writes back to the MIDI, so
re-transcription is only a re-render. Print and PDF export consume the rendered
SVG pages.

### Persistence

Projects are `.szd` archives — zip-packed JSON plus assets — stored in OPFS
under `projects/<name>.szd`, with a debounced autosave slot, named revisions and
whole-storage backups, alongside download and upload to local disk. Audio assets
and SoundFonts are content-addressed in `assets/` and `fonts/`.

## Testing

Unit and component tests run under Vitest with jsdom. Real `AudioContext` and
canvas-2d are unavailable there, so DSP and geometry logic lives in pure TS
modules and components are tested against mocks: `tests/fake-wasm.ts` is the
shared `Project` mock and `tests/fake-audio-context.ts` fakes the audio graph.

The browser end-to-end run drives a headless Chromium against a dev server
through the real engine — boot and cross-origin isolation, note editing and
undo, score engraving and annotations, shortcuts and layouts, OPFS persistence,
audio import and recording, the mixer, device rack, step sequencer, automation,
cycle recording, routing, warp, freeze, mastering, and the audio, MIDI and
DAWproject exports. Scenarios share one page and run in order, so each builds on
what the last one left behind.

```sh
yarn dev --port 5199   # in the background

node scripts/e2e-smoke.mjs
node scripts/e2e-smoke.mjs --list
node scripts/e2e-smoke.mjs --only=boot,piano-roll,score
node scripts/e2e-smoke.mjs --through=audio-record
```

Playwright is resolved from the temp roots first, then the project directory.

`src/wasm/**` is generated output from libsonare. Never edit it by hand; re-run
`yarn copy:wasm` instead.

## Deployment

The app is a static site, but it has to be served cross-origin isolated.

- `public/_headers` (Cloudflare Pages format) sets
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: cross-origin` on every path, plus the
  `application/wasm` content type. `public/_redirects` routes everything to
  `index.html`.
- Because of `require-corp`, **every asset must be same-origin** — no CDN
  scripts, no cross-origin fonts.
- That catch-all rewrite means a path the current deploy no longer serves
  answers `200 text/html` instead of `404`. The Service Worker treats a document
  under a non-document URL as a stale asset: it refuses to precache one, never
  admits one to a release cache, and answers `404` for it, so the app can offer
  a reload rather than fail on an unparseable script.
- `_headers` also pins the caching contract the release model depends on.
  `/assets/*` is immutable, while `sw.js`, `precache-manifest.json`,
  `worklet-manifest.json` and the document under both `/` and `/index.html` are
  revalidated on every request, so a worker is never paired with another
  release's manifest or document.
- Keep every deployed file under 25 MiB, the Cloudflare Pages per-file limit.
  The largest artifact is the bundled Verovio engraving worker at roughly
  7.5 MiB; `sonare.wasm` is about 4 MiB.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See
[LICENSE](./LICENSE).

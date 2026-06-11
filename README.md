# sonare studio

A digital audio workstation that runs entirely in the browser, built on the
[libsonare](../libsonare) WebAssembly engine.

- Multi-track sequencing with MIDI and audio clips, markers and sections
- Piano roll with snap grid, velocity/controller lanes, ghost notes and
  QWERTY music typing / step input
- Engraved score view (Verovio) with chord symbol estimation, page layout
  controls, print, PDF and MusicXML export — strictly non-destructive: the
  score is derived from the MIDI notes and never writes back to them
- Mixer with per-strip gain/pan/sends, EQ, insert effects and metering
- Track instruments: built-in synth presets and SoundFont (SF2) playback
- Step sequencer with pattern, Euclidean and randomize tools
- Microphone recording with monitoring, count-in and metronome
- Sample editor for audio clip content
- Mastering chain (e.g. brickwall limiter, tape) on the master bus
- Export: WAV / MP3 mixdown with loudness report, DAWproject, Standard MIDI
  File, MusicXML
- Projects persist as `.szd` files (zip-packed JSON + assets) in the browser's
  origin-private file system (OPFS), with autosave and local file
  import/export; Web MIDI input is supported where available
- Display-only score annotations (dynamics, articulations, slurs) and an
  engraving-only transpose, applied from the score panel's Annotate palette
- Remappable keyboard shortcuts with a `?` cheatsheet overlay, an application
  settings dialog, named workspace layouts (Compose / Mix / Score presets plus
  saved layouts) and a first-run welcome tour

## Requirements

- A modern Chromium- or Firefox-based browser. The app uses AudioWorklet,
  WebAssembly, OPFS and (when available) SharedArrayBuffer.
- Cross-origin isolation. The dev/preview servers and the bundled
  `public/_headers` file send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which SharedArrayBuffer
  requires. Without isolation the engine falls back to a postMessage
  transport.
- Node 24 and Yarn 4 (pinned via [Volta](https://volta.sh) in
  `package.json`).

## Quickstart

```sh
yarn install

# Copy the libsonare wasm artifacts (expects a sibling checkout at
# ../libsonare with bindings/wasm/dist built).
yarn copy:wasm

yarn dev
```

Open the printed URL, press **Start engine** in the toolbar, then **Play**.
Starting the engine only opens the audio device; nothing sounds until
playback starts.

## Scripts

| Script | Description |
| --- | --- |
| `yarn dev` | Vite dev server with cross-origin-isolation headers |
| `yarn build` | Worklet bundle + type check + production build |
| `yarn build:worklet` | Build the self-contained AudioWorklet module only |
| `yarn preview` | Serve the production build locally |
| `yarn copy:wasm` | Sync wasm artifacts from `../libsonare` into `src/wasm/` |
| `yarn test` / `yarn test:watch` | Vitest (jsdom) unit/component tests |
| `yarn lint` / `yarn lint:fix` | Biome check / autofix |
| `yarn typecheck` | `vue-tsc --noEmit` |
| `yarn verify` | lint + test + build |

End-to-end smoke test (drives a headless Chromium against a running dev
server; Playwright is resolved from `/tmp/node_modules`):

```sh
yarn dev --port 5199   # in the background
node scripts/e2e-smoke.mjs
```

## Architecture

### Shell layout

```
+--------------------------------------------------------------------+
| Transport bar: engine / play / record / tempo / project menu       |
+----------------------------------------------------+---------------+
| Arrangement: tracks, clips, sections, markers      | Device rack:  |
|                                                    | instrument +  |
+----------------------------------------------------+ insert chain  |
| Editor dock: Piano roll | Mixer | Mastering | Steps| per track     |
|   | Lists | Media | Sample      [+ Score panel]    |               |
+----------------------------------------------------+---------------+
```

Vue 3 + Pinia drive the UI; heavy surfaces (arrangement, piano roll,
waveforms) are canvas-2d layers repainted through a requestAnimationFrame
batcher (`src/ui/canvas/`).

### Two-layer engine

libsonare ships as two wasm builds, copied into `src/wasm/` (generated,
read-only):

- `sonare.wasm` — the full project model and offline renderer. It runs on the
  main thread (and in workers for export) and owns the musical source of
  truth: tracks, clips, notes, tempo, SMF/MIDI codecs.
- `sonare-rt.wasm` — a lean realtime runtime loaded inside an AudioWorklet
  (`public/sonare-engine-worklet.js`, built by `yarn build:worklet`). It
  plays scheduled PCM against the transport and reports meters/telemetry.
  Control traffic uses SharedArrayBuffer when cross-origin isolation is
  available and degrades to postMessage otherwise (`src/engine/engine.ts`).

Playback uses a prerender path: MIDI clips are bounced offline to stereo PCM
with the track's instrument (`src/engine/instruments.ts`, content-keyed
cache) and the resulting audio is scheduled into the realtime engine. Edits
re-bounce affected clips with a short debounce.

The wasm `Project` instance is intentionally non-reactive. All project edits
go through the command layer in `src/project/commands.ts`, which keeps a
dual-layer undo history (wasm edits + app-level metadata snapshots) and
refreshes the reactive Pinia mirror that components read.

### Non-destructive notation

The score panel quantizes the active clip's notes into a display-only model
(`src/notation/model.ts`), serializes it to MusicXML and engraves it with
Verovio in a worker. Nothing in this pipeline writes back to the MIDI data;
re-transcription is just a re-render. Print and PDF export consume the
rendered SVG pages.

### Persistence

Projects are saved as `.szd` archives in OPFS (`projects/<name>.szd`), with a
debounced autosave slot, plus download/upload to the local disk. Audio assets
and SoundFonts are content-addressed in OPFS (`assets/`, `fonts/`). See
`docs/shortcuts.md` for the keyboard shortcut reference.

## Development notes

- Tests run under Vitest with jsdom. Real `AudioContext` and canvas-2d are
  unavailable there, so DSP/geometry logic lives in pure TS modules and
  components are tested with mocks; `tests/fake-wasm.ts` is the shared
  `Project` mock and `tests/fake-audio-context.ts` fakes the audio graph.
- `src/wasm/**` is generated output from libsonare — never edit it by hand;
  re-run `yarn copy:wasm` instead.
- `scripts/e2e-smoke.mjs` covers the full user path (boot, cross-origin
  isolation, the welcome tour, note editing, undo, score engraving and
  annotations, shortcut help and remapping, workspace layouts, save/restore,
  audio import, recording, mixer, devices, steps, mastering, audio and
  DAWproject export) via the dev-only `window.__sonareDebug` hook.

## Deployment

The app is a static site, but it must be served cross-origin isolated:

- `public/_headers` (Cloudflare Pages format) sets
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: cross-origin` for every path, plus the
  `application/wasm` content type. `public/_redirects` routes everything to
  `index.html`.
- Because of `require-corp`, **all assets must be same-origin** — no CDN
  scripts or cross-origin fonts.
- Keep every deployed file under 25 MiB (the Cloudflare Pages per-file
  limit); the largest artifact today is the bundled Verovio engraving worker
  at roughly 8 MiB (`sonare.wasm` is just under 3 MiB).

## License

Apache-2.0

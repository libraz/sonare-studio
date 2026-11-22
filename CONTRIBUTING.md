# Contributing to sonare studio

Contributions are welcome, including small and unfinished ones. A maintainer reviews every pull request, finishes what is missing, and merges it, so you do not need to get everything in this document right, or even read all of it.

## What a pull request needs

- A description of what the change does and why. If the intent is clear, the maintainer can verify the behaviour.
- If you can, a build and the tests for the part you changed.

That is all. A red check, a missing translation, or a test you did not write is fine: say what you know in the pull request, and the maintainer will finish it or tell you what is left. Target `main`.

For a larger change, such as a new editor panel or a change to the `.szd` project format, opening an issue first to describe the idea can save you work. It is not required.

Reporting a bug you do not intend to fix is a useful contribution too, and needs none of the setup below.

### What the maintainer can verify

The maintainer tests on macOS in every shipped language and on Windows in Japanese only. If your change depends on Windows in another language (a keyboard layout, an IME, a system font, a locale-specific shortcut), describe what you see there, ideally with a screenshot, because it cannot be reproduced on the maintainer's side. The same goes for audio and MIDI hardware the maintainer does not have: say which interface or controller you used.

## What you are contributing to

A browser DAW written in TypeScript and Vue 3:

- `src/project/` is the project model's TypeScript side: the command layer every edit goes through, undo, and the document format.
- `src/engine/` drives the realtime engine in the AudioWorklet; `src/export/` renders and writes files offline.
- `src/compose/` adapts the theory library to the project; `src/notation/` builds the engraved score.
- `src/components/` and `src/ui/` are the Vue components and the framework-free UI helpers, including the locale tables under `src/ui/i18n/`.

The audio engine itself is [libsonare](https://github.com/libraz/libsonare), installed from npm as `@libraz/libsonare`. DSP that sounds wrong, an analysis result that is off, or an engine call that fails belongs in the [libsonare repository](https://github.com/libraz/libsonare/issues). Chord, key and counterpoint results come from [libcantus](https://github.com/libraz/libcantus), and wrong theory goes there.

The rest of this document has two parts. [Checklist](#checklist) describes what a finished change looks like. [Reference](#reference) explains how the checks behave.

## Development setup

Node 26 and Yarn 4 (the versions are pinned in `mise.toml`, `.node-version` and `package.json`). Use Yarn; npm, pnpm and bun are not supported in this repository.

```bash
yarn install
yarn dev              # dev server with cross-origin-isolation headers
yarn test             # unit and component tests (vitest)
yarn lint             # Biome; yarn lint:fix applies fixes
yarn typecheck
```

The browser end-to-end run drives a headless Chromium through Playwright against a static production build, so it needs Playwright's Chromium installed once:

```bash
yarn playwright install chromium
yarn e2e                                   # every scenario
yarn e2e --list                            # scenario names
yarn e2e --only=boot,piano-roll,score      # a subset
yarn e2e --through=audio-record            # from the start up to one scenario
```

## What CI requires

| Workflow                   | Trigger                         | Runs                                                              |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `.github/workflows/ci.yml` | push and pull request to `main` | immutable install, lint, spec type check, tests, production build |

A red check is no reason to hold a pull request back. The external-format tests and the end-to-end run are not in the workflow: before merging, the maintainer runs `yarn ci`, which is `yarn verify` (lint, type checks, tests, external-format tests, build) followed by the end-to-end run.

## Checklist

This is what a change looks like by the time it is merged. The maintainer checks it and fills in what is missing, so you are not expected to know all of it.

- Make every project edit through a command in `src/project/command/`, so it lands in the undo history and the reactive mirror.
- Give a control that can be unavailable a reason: one `firstBlock(...)` from `src/ui/disabled-reason.ts` drives both `:disabled` and the tooltip's `reason`.
- Take shortcut hints from the action ids in `src/ui/settings/shortcuts.ts`, and update `docs/en/shortcuts.md` and `docs/ja/shortcuts.md` when an action changes.
- Add a new UI string to both locale trees, `src/ui/i18n/en/` and `src/ui/i18n/ja/`. English text in the Japanese tree is fine; the maintainer translates it.
- Keep a new export option off by default, so existing exports stay byte-identical.
- When the engine lacks something a feature needs, report it to libsonare rather than working around it in the app.
- Add tests under `tests/` for the code you changed. Where a change fixes a defect, include a test that fails without the fix.
- Write comments in English and give exported symbols a TSDoc comment.

### Commit messages

Conventional Commits, in English: `type(scope): summary`, lowercase after the colon, no trailing period. A body, when there is one, is a blank line followed by `- ` bullets. Commit messages can be rewritten at merge, so do not let them hold up a pull request.

## Reference

Nothing in this section asks anything of you; read it when a checklist item or a check puzzles you.

- Unit and component tests run under Vitest with jsdom. A real `AudioContext` and canvas-2d are unavailable there, so DSP and geometry logic lives in pure TypeScript modules and components are tested against fakes: `tests/fake-wasm.ts` fakes the engine's `Project` and `tests/fake-audio-context.ts` fakes the audio graph. Specs that need the real engine load its wasm through `tests/core-package.ts`.
- The engine's `Project` is deliberately non-reactive. Writing to it outside a command leaves the UI showing the old state and the edit out of the undo history.
- The message parity test compares the assembled English and Japanese trees, so a string added to one locale and not the other fails `yarn test`.
- Some checks guard the seam to the engine and the shape of the build: the spec type-check ceiling, the core contract specs (`tests/core-*.spec.ts`) and the bundle check at the end of `yarn build`. The maintainer runs and maintains them; a change that trips one is still welcome.
- Most end-to-end scenarios share one page and run in order; the portable project and revision scenarios use fresh browser contexts. The production-journey scenarios start from empty browser storage, save and reopen the project, and inspect the real downloaded WAV, MIDI or ZIP files.
- Service Workers are disabled on the dev server. `node scripts/e2e-pages.mjs` after `yarn build` serves the build with Cloudflare Pages-style redirects and exercises Service Worker installation, release changes, cache repair and offline revisits.
- `yarn test:external-formats` downloads the pinned MusicXML and DAWproject schemas and validates exported files against them with `xmllint`, so it needs network access and `xmllint` on `PATH`. `tests/external-formats.md` lists its optional inputs.

## Reporting issues

Search the existing issues first, then include what you did, what happened, what you expected, the commit or deployed version, your OS and its display language, the browser, and any audio or MIDI device involved. For a problem with a project or an imported file, the file matters more than anything else in the report.

Security vulnerabilities go through the process in [SECURITY.md](SECURITY.md), not the public issue tracker.

## Licence

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License v3.0 or later.

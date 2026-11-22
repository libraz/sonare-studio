# Getting started

## Requirements

- A current Chromium- or Firefox-based browser. The app needs AudioWorklet, WebAssembly, OPFS, and SharedArrayBuffer where available.
- **Cross-origin isolation.** The dev and preview servers, and the bundled `public/_headers`, send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which SharedArrayBuffer requires. Without isolation the engine falls back to a postMessage transport and still works.
- To run it locally: Node 24 and Yarn 4, pinned in `mise.toml` via [mise](https://mise.jdx.dev).

## Run locally

```sh
yarn install
yarn dev
```

Open the printed URL. The start screen offers a new project, the bundled demo (Toccata and Fugue in D minor, BWV 565) or anything already in browser storage. Press **Play** and the audio engine boots on its own.

`yarn build` writes the production build to `dist/`, and `yarn preview` serves it with the same isolation headers. Serving the build anywhere else is covered on the [deployment](deployment.md) page.

## Scripts

| Script                          | Description                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `yarn dev`                      | Vite dev server with cross-origin-isolation headers                                                    |
| `yarn build`                    | Worklet bundle, type check, production build, then a check that the build carries the installed engine |
| `yarn build:worklet`            | Build the self-contained AudioWorklet module only                                                      |
| `yarn preview`                  | Serve the production build locally                                                                     |
| `yarn test` · `yarn test:watch` | Vitest (jsdom) unit and component tests                                                                |
| `yarn test:coverage`            | The same suite with v8 coverage                                                                        |
| `yarn test:external-formats`    | Validate exported files with external tools                                                            |
| `yarn lint` · `yarn lint:fix`   | Biome check / autofix                                                                                  |
| `yarn typecheck`                | `vue-tsc --noEmit`                                                                                     |
| `yarn verify`                   | lint, spec type check, tests, external-format tests, build                                             |
| `yarn e2e`                      | Browser end-to-end run against a static production build                                               |
| `yarn ci`                       | `verify`, then `e2e`                                                                                   |

The test layout and the end-to-end harness are described in [CONTRIBUTING.md](../../CONTRIBUTING.md).

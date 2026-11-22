# Deployment

The app is a static site, but it has to be served cross-origin isolated. `yarn build` writes it to `dist/`; the headers and redirects below ship in `public/` in Cloudflare Pages format.

## Headers and routing

- `public/_headers` sets `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin` on every path, plus the `application/wasm` content type. `public/_redirects` routes everything to `index.html`.
- Because of `require-corp`, **every asset must be same-origin**: no CDN scripts, no cross-origin fonts.
- The catch-all rewrite means a path the current deploy no longer serves answers `200 text/html` instead of `404`. The Service Worker treats a document under a non-document URL as a stale asset: it refuses to precache one, never admits one to a release cache, and answers `404` for it, so the app can offer a reload rather than fail on an unparseable script.

## Caching and the Service Worker

- `_headers` also pins the caching contract the release model depends on. `/assets/*` is immutable, while `sw.js`, `precache-manifest.json`, `worklet-manifest.json` and the document under both `/` and `/index.html` are revalidated on every request, so a worker is never paired with another release's manifest or document.
- The Service Worker uses `/` as the canonical document. Cloudflare Pages redirects `/index.html` to `/`; a followed redirect must be reconstructed before it can answer a browser navigation. Installation also repairs redirected documents in older app caches, and the worker template contributes to the release cache identity.
- An already installed broken worker can fail a return navigation before its replacement installs. The replacement repairs that cache without deleting stored projects; subsequent ordinary navigations can recover. An in-document recovery script cannot handle a failure that occurs before the document loads.

## File size

Keep every deployed file under 25 MiB, the Cloudflare Pages per-file limit. The largest artifacts are the bundled Verovio engraving worker and `sonare.wasm`, each a few MiB.

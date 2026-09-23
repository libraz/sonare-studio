#!/bin/bash
set -euo pipefail

LIBSONARE_DIR="../libsonare"
WASM_PKG_DIR="$LIBSONARE_DIR/bindings/wasm"
DIST_DIR="$WASM_PKG_DIR/dist"
DEST_DIR="src/wasm"

# Runtime artifacts: the Emscripten module, the high-level API, and the
# AudioWorklet entry. index.js / worklet.js import ./sonare.js dynamically.
RUNTIME_FILES=("sonare.wasm" "sonare.js" "index.js" "worklet.js")

# dist/sonare.d.ts re-exports '../src/sonare.js', which does not exist once
# vendored; the hand-written module declaration it points at is copied in its
# place so the declaration tree resolves inside src/wasm alone.
MODULE_DECL_SRC="$WASM_PKG_DIR/src/sonare.js.d.ts"

# Files kept in DEST_DIR that the sync must not delete.
KEEP_FILES=("meta.json")

echo "📦 Copying WASM files from libsonare..."

if [ ! -d "$DIST_DIR" ]; then
  echo "❌ Error: $DIST_DIR not found"
  echo "   Clone libsonare next to this repo and run 'yarn build' in bindings/wasm."
  exit 1
fi

missing=()
for file in "${RUNTIME_FILES[@]}" "index.d.ts" "worklet.d.ts"; do
  [ -f "$DIST_DIR/$file" ] || missing+=("$file")
done
[ -f "$MODULE_DECL_SRC" ] || missing+=("${MODULE_DECL_SRC#"$WASM_PKG_DIR/"}")
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Error: missing in libsonare:"
  printf '   - %s\n' "${missing[@]}"
  echo "   Run 'yarn build' in libsonare/bindings/wasm first."
  exit 1
fi

# The dist must be built from the sources it sits next to.
if ! (cd "$WASM_PKG_DIR" && node scripts/dist-source-manifest.mjs >/dev/null); then
  echo "❌ Error: libsonare dist is stale against its sources"
  echo "   Rebuild with 'yarn build' in libsonare/bindings/wasm."
  exit 1
fi

STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

for file in "${RUNTIME_FILES[@]}"; do
  cp "$DIST_DIR/$file" "$STAGE_DIR/"
done
mkdir -p "$STAGE_DIR/worklet"
for decl in "$DIST_DIR"/*.d.ts; do
  # Shims into libsonare's own src/ cannot resolve here; sonare.d.ts is
  # replaced below and the analysis-only module is not vendored.
  grep -q "from '\.\./src/" "$decl" && continue
  cp "$decl" "$STAGE_DIR/"
done
cp "$DIST_DIR"/worklet/*.d.ts "$STAGE_DIR/worklet/"
cp "$MODULE_DECL_SRC" "$STAGE_DIR/sonare.d.ts"

# Source maps are not vendored.
find "$STAGE_DIR" \( -name '*.js' -o -name '*.d.ts' \) -print0 |
  xargs -0 sed -i.bak '/^\/\/# sourceMappingURL=/d'
find "$STAGE_DIR" -name '*.bak' -delete

RSYNC_ARGS=(-rc --delete)
for keep in "${KEEP_FILES[@]}"; do
  RSYNC_ARGS+=(--exclude "/$keep")
done

CHANGES=$(rsync "${RSYNC_ARGS[@]}" --dry-run --itemize-changes "$STAGE_DIR/" "$DEST_DIR/")
if [ -z "$CHANGES" ]; then
  echo "✅ No changes detected — src/wasm matches libsonare"
  exit 0
fi

echo "$CHANGES" | sed 's/^/   /'
rsync "${RSYNC_ARGS[@]}" "$STAGE_DIR/" "$DEST_DIR/"

echo ""
./scripts/update-wasm-meta.sh
echo ""
echo "✅ src/wasm updated"

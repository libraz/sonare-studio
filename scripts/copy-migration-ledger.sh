#!/bin/bash
# Vendors libsonare's WASM migration ledger (every name the 2.0 surface
# removed, renamed or reshaped from 1.x) next to the declarations it describes,
# and records its hash and source commit in src/wasm/migration-ledger.json.
# tests/core-migration-ledger.spec.ts reads both.
set -euo pipefail

LIBSONARE_DIR="${LIBSONARE_DIR:-../libsonare}"
SOURCE="tools/api/migration/wasm.toml"
DEST="src/wasm/migration-ledger.toml"
META="src/wasm/migration-ledger.json"

if [ ! -f "$LIBSONARE_DIR/$SOURCE" ]; then
  echo "❌ Error: $LIBSONARE_DIR/$SOURCE not found"
  exit 1
fi
if [ -n "$(git -C "$LIBSONARE_DIR" status --porcelain -- "$SOURCE")" ]; then
  echo "❌ Error: $SOURCE has uncommitted changes in libsonare"
  exit 1
fi

cp "$LIBSONARE_DIR/$SOURCE" "$DEST"
if [[ "$OSTYPE" == "darwin"* ]]; then
  SHA256=$(shasum -a 256 "$DEST" | cut -d' ' -f1)
else
  SHA256=$(sha256sum "$DEST" | cut -d' ' -f1)
fi
COMMIT=$(git -C "$LIBSONARE_DIR" log -1 --format=%h -- "$SOURCE")

cat > "$META" << JSON
{
  "source": "$SOURCE",
  "sourceCommit": "$COMMIT",
  "sha256": "$SHA256"
}
JSON

echo "📒 Vendored $SOURCE at $COMMIT ($SHA256)"

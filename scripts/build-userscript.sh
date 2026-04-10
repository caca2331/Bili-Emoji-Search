#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

build_bundle() {
  local out_file="$1"
  shift
  local parts=("$@")

  : > "$out_file"
  for part in "${parts[@]}"; do
    cat "$ROOT_DIR/$part" >> "$out_file"
    printf '\n\n' >> "$out_file"
  done

  printf 'Built %s\n' "$out_file"
}

mkdir -p "$ROOT_DIR/dist"

COMMON_PARTS=(
  "src/bootstrap.js"
  "src/storage.js"
  "src/search.js"
  "src/registry.js"
  "src/ui.js"
  "src/app.js"
)

build_bundle \
  "$ROOT_DIR/dist/bili-emoji-search.user.js" \
  "src/meta.js" \
  "src/debug.off.js" \
  "${COMMON_PARTS[@]}"

build_bundle \
  "$ROOT_DIR/dist/bili-emoji-search.debug.user.js" \
  "src/meta.debug.js" \
  "src/debug.on.js" \
  "${COMMON_PARTS[@]}"

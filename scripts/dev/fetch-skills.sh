#!/usr/bin/env bash
# Fetch the pinned ai4s-skills pack into runtime/skills/external/ai4s-skills/
# (git-ignored; bundled into the installer as a Tauri resource).
# Runs locally and in CI so the skills never live in this repo's git history.
set -euo pipefail

AI4S_SKILLS_COMMIT="${AI4S_SKILLS_COMMIT:-8fa2ab0523082c135598909b227ed8feb48263ad}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/runtime/skills/external/ai4s-skills"

URL="https://github.com/ai4s-research/ai4s-skills/archive/${AI4S_SKILLS_COMMIT}.tar.gz"
TMP="$(mktemp -d)"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/skills.tar.gz"
tar -xzf "$TMP/skills.tar.gz" -C "$TMP"

SRC="$(find "$TMP" -maxdepth 1 -type d -name 'ai4s-skills-*' | head -1)"
[ -d "$SRC/skills" ] || { echo "No skills/ directory in archive" >&2; exit 1; }

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$SRC/skills/." "$OUT_DIR/"
echo "$AI4S_SKILLS_COMMIT" > "$OUT_DIR/.commit"
rm -rf "$TMP"

echo "Placed ai4s-skills@${AI4S_SKILLS_COMMIT:0:7} in $OUT_DIR:"
ls "$OUT_DIR"

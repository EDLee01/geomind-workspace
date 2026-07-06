#!/usr/bin/env bash
# Fetch the bundled Magi agent runtime as a Tauri RESOURCE
# (apps/desktop/src-tauri/resources/magi/{node,pkg}). Magi is an npm package
# (@edwardlee5423/magi) run via Node — not a single native binary — so it ships
# as a resource folder: a pinned Node runtime plus the package tree installed
# with --omit=dev (which pulls the platform-native better-sqlite3 addon).
#
# NATIVE-MODULE CONSTRAINT: better-sqlite3 is a native addon whose prebuilt
# binary is specific to the platform + Node ABI. `npm install` here compiles/
# downloads it for the HOST triple only, so a tree produced on Linux is NOT
# valid for macOS/Windows. That is fine: the CI matrix runs this script on each
# platform's own runner (macos/windows), so every shipped target gets a correct
# native addon. Locally, it produces a tree valid for your own machine.
set -euo pipefail

MAGI_VERSION="${MAGI_VERSION:-0.1.13}"
NODE_VERSION="${NODE_VERSION:-22.23.1}"   # current 22 LTS ("Jod"); magi needs node >=22
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/resources/magi"

TRIPLE="${1:-$(rustc -Vv | sed -n 's/host: //p')}"

# Map the Rust target triple to Node's dist asset name + archive layout.
case "$TRIPLE" in
  aarch64-apple-darwin)    NODE_ARCH="darwin-arm64"; NODE_EXT="tar.gz" ;;
  x86_64-apple-darwin)     NODE_ARCH="darwin-x64";   NODE_EXT="tar.gz" ;;
  x86_64-pc-windows-msvc)  NODE_ARCH="win-x64";      NODE_EXT="zip" ;;
  aarch64-pc-windows-msvc) NODE_ARCH="win-arm64";    NODE_EXT="zip" ;;
  *) echo "Unsupported triple: $TRIPLE" >&2; exit 1 ;;
esac

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/node" "$OUT_DIR/pkg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Node runtime for the target platform.
NODE_PKG="node-v${NODE_VERSION}-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.${NODE_EXT}"
echo "Downloading Node: $NODE_URL"
curl -fsSL "$NODE_URL" -o "$TMP/node.${NODE_EXT}"
case "$NODE_EXT" in
  tar.gz) tar -xzf "$TMP/node.${NODE_EXT}" -C "$TMP" ;;
  zip)    unzip -oq "$TMP/node.${NODE_EXT}" -d "$TMP" ;;
esac

# Place just the node executable at resources/magi/node/node[.exe].
if [ -f "$TMP/$NODE_PKG/node.exe" ]; then
  cp "$TMP/$NODE_PKG/node.exe" "$OUT_DIR/node/node.exe"
else
  cp "$TMP/$NODE_PKG/bin/node" "$OUT_DIR/node/node"
  chmod +x "$OUT_DIR/node/node"
fi

# 2) Magi package tree (prod deps only), installed with the SAME node major we
#    ship so the native better-sqlite3 ABI matches.
echo "Installing @edwardlee5423/magi@${MAGI_VERSION} (--omit=dev)"
( cd "$OUT_DIR/pkg" \
  && npm init -y >/dev/null 2>&1 \
  && npm install "@edwardlee5423/magi@${MAGI_VERSION}" --omit=dev --no-audit --no-fund )

# Sanity: the CLI entry the app spawns must exist.
CLI="$OUT_DIR/pkg/node_modules/@edwardlee5423/magi/dist/cli.js"
[ -f "$CLI" ] || { echo "magi cli.js not found at $CLI" >&2; exit 1; }

echo "Placed Magi runtime for $TRIPLE in $OUT_DIR (node v${NODE_VERSION}, magi ${MAGI_VERSION})"

#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Build Glooow.app and package it into a DMG
# Requires: pyinstaller, create-dmg (brew install create-dmg)
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

APP_NAME="Glooow"
APP_PATH="dist/$APP_NAME.app"
DMG_NAME="$APP_NAME-Installer"
DMG_PATH="dist/$DMG_NAME.dmg"
ICON_PATH="assets/glooow.icns"

# ── Preflight checks ──────────────────────────────

if ! command -v create-dmg &>/dev/null; then
    echo "Error: create-dmg not found. Install with: brew install create-dmg"
    exit 1
fi

if [ ! -f "$ICON_PATH" ]; then
    echo "Error: Icon not found at $ICON_PATH"
    echo "Run: scripts/generate-icon.sh"
    exit 1
fi

# ── Step 1: Build with PyInstaller ────────────────

echo "==> Building $APP_NAME.app with PyInstaller..."
uv run pyinstaller glooow.spec --noconfirm

if [ ! -d "$APP_PATH" ]; then
    echo "Error: PyInstaller build failed — $APP_PATH not found"
    exit 1
fi

# ── Step 2: Ad-hoc code sign ─────────────────────

echo "==> Code signing $APP_NAME.app..."
codesign --deep --force --sign - "$APP_PATH"

# ── Step 3: Create DMG ───────────────────────────

# Remove old DMG if it exists (create-dmg won't overwrite)
rm -f "$DMG_PATH"

echo "==> Creating DMG installer..."
create-dmg \
    --volname "$APP_NAME" \
    --volicon "$ICON_PATH" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "$APP_NAME.app" 150 190 \
    --hide-extension "$APP_NAME.app" \
    --app-drop-link 450 190 \
    --no-internet-enable \
    "$DMG_PATH" \
    "$APP_PATH"

echo ""
echo "==> Done! DMG created at: $DMG_PATH"
echo "    Size: $(du -h "$DMG_PATH" | cut -f1)"

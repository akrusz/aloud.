#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Build aloud.app, sign + notarize, package + sign + notarize DMG.
#
# Requires:
#   - pyinstaller (via uv)
#   - create-dmg  (brew install create-dmg)
#   - Developer ID Application cert in keychain
#   - notarytool keychain profile stored once via:
#       xcrun notarytool store-credentials "notary" \
#         --apple-id YOU@EXAMPLE.COM --team-id TEAMID --password APP-SPECIFIC-PW
#
# Env vars:
#   CODESIGN_IDENTITY    — "Developer ID Application: Name (TEAMID)". Falls back
#                          to "aloud Dev" self-signed cert, then ad-hoc.
#   NOTARYTOOL_PROFILE   — keychain profile name (default "notary").
#   SKIP_NOTARIZE=1      — skip notarization (faster dev builds).
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

APP_NAME="aloud"
APP_PATH="dist/$APP_NAME.app"
VERSION=$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"(.+?)\"', open('src/__init__.py').read()).group(1))")
DMG_NAME="$APP_NAME-${VERSION}-macOS"
DMG_PATH="dist/$DMG_NAME.dmg"
ICON_PATH="assets/aloud.icns"
NOTARYTOOL_PROFILE="${NOTARYTOOL_PROFILE:-notary}"

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
uv run pyinstaller aloud.spec --noconfirm

if [ ! -d "$APP_PATH" ]; then
    echo "Error: PyInstaller build failed — $APP_PATH not found"
    exit 1
fi

# ── Step 2: Code sign ───────────────────────────
# For distribution: use a "Developer ID Application: …" cert (required for
# notarization). For local dev: self-signed "aloud Dev" or ad-hoc.

ENTITLEMENTS="$PROJECT_DIR/assets/entitlements.plist"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    SIGN_ID="$CODESIGN_IDENTITY"
elif security find-identity -v -p codesigning | grep -q '"aloud Dev"'; then
    SIGN_ID="aloud Dev"
else
    SIGN_ID="-"
fi

echo "==> Code signing $APP_NAME.app (identity: ${SIGN_ID})..."

# Recursive signing: nested Mach-O binaries (dylibs, .so extensions) must be
# signed individually before the outer bundle, otherwise notarization rejects
# them. --deep is deprecated and unreliable for PyInstaller bundles, which
# embed Python's C-extension .so files in unusual places.
#
# Entitlements go ONLY on the outer bundle's main executable — they're
# meaningless on library files and including them can trip notarization
# checks. --timestamp uses Apple's timestamp server (required for notarize).

# 1. Sign every .dylib and .so inside the bundle, hardened runtime + timestamp.
find "$APP_PATH" -type f \( -name "*.dylib" -o -name "*.so" \) -print0 |
    while IFS= read -r -d '' f; do
        codesign --force --options runtime --timestamp \
            --sign "$SIGN_ID" "$f"
    done

# 2. Sign nested executables that aren't .dylib/.so (e.g., Python's bin/python3
#    if PyInstaller bundled the framework). Find Mach-O executables that aren't
#    already signed above.
find "$APP_PATH/Contents" -type f -perm -u+x ! -name "*.dylib" ! -name "*.so" \
    ! -path "$APP_PATH/Contents/MacOS/$APP_NAME" -print0 2>/dev/null |
    while IFS= read -r -d '' f; do
        # Only sign Mach-O files (not shell scripts, plists, etc.)
        if file "$f" | grep -q "Mach-O"; then
            codesign --force --options runtime --timestamp \
                --sign "$SIGN_ID" "$f" 2>/dev/null || true
        fi
    done

# 3. Sign the outer bundle with entitlements + hardened runtime.
codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_ID" "$APP_PATH"

# Verify the bundle signature is consistent.
codesign --verify --strict --verbose=2 "$APP_PATH" 2>&1 | tail -5

# ── Decide whether to notarize ────────────────────
# Notarization requires a real Developer ID cert + a stored notarytool
# profile. Skip cleanly if either is missing or SKIP_NOTARIZE=1 is set.

WILL_NOTARIZE=0
if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
    echo "==> SKIP_NOTARIZE=1 — skipping notarization."
elif [[ "$SIGN_ID" != "Developer ID Application:"* ]] && [[ "$SIGN_ID" != "Developer ID:"* ]]; then
    echo "==> SIGN_ID is '$SIGN_ID' (not a Developer ID cert) — skipping notarization."
elif ! xcrun notarytool history --keychain-profile "$NOTARYTOOL_PROFILE" &>/dev/null; then
    echo "==> notarytool profile '$NOTARYTOOL_PROFILE' not found — skipping notarization."
    echo "    To enable: xcrun notarytool store-credentials \"$NOTARYTOOL_PROFILE\" \\"
    echo "      --apple-id YOU@EXAMPLE.COM --team-id TEAMID --password APP-SPECIFIC-PW"
else
    WILL_NOTARIZE=1
fi

# ── Step 2.5: Notarize the .app ──────────────────

if [ "$WILL_NOTARIZE" = "1" ]; then
    ZIP_PATH="dist/$APP_NAME.zip"
    echo "==> Zipping app for notarization..."
    ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

    echo "==> Submitting app to Apple notary service (this can take a few minutes)..."
    xcrun notarytool submit "$ZIP_PATH" \
        --keychain-profile "$NOTARYTOOL_PROFILE" \
        --wait
    rm -f "$ZIP_PATH"

    echo "==> Stapling notarization ticket to $APP_NAME.app..."
    xcrun stapler staple "$APP_PATH"
fi

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

# ── Step 4: Sign + notarize the DMG ───────────────

echo "==> Code signing DMG (identity: ${SIGN_ID})..."
codesign --force --sign "$SIGN_ID" "$DMG_PATH"

if [ "$WILL_NOTARIZE" = "1" ]; then
    echo "==> Submitting DMG to Apple notary service..."
    xcrun notarytool submit "$DMG_PATH" \
        --keychain-profile "$NOTARYTOOL_PROFILE" \
        --wait

    echo "==> Stapling notarization ticket to DMG..."
    xcrun stapler staple "$DMG_PATH"
fi

echo ""
echo "==> Done! DMG created at: $DMG_PATH"
echo "    Size: $(du -h "$DMG_PATH" | cut -f1)"
if [ "$WILL_NOTARIZE" = "1" ]; then
    echo "    Notarized + stapled — users can double-click without right-click → Open."
fi

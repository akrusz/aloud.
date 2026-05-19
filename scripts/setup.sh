#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# aloud — Setup (fresh setup / update / uninstall)
# Usage: curl -fsSL https://raw.githubusercontent.com/akrusz/aloud/main/scripts/setup.sh | bash
# ─────────────────────────────────────────────────

BREADCRUMB="$HOME/.aloud-path"
REPO_URL="https://github.com/akrusz/aloud.git"

# Resolve path: env var > breadcrumb > default
if [ -n "${ALOUD_DIR:-}" ]; then
    ALOUD_DIR="$ALOUD_DIR"
elif [ -f "$BREADCRUMB" ]; then
    ALOUD_DIR="$(cat "$BREADCRUMB")"
else
    ALOUD_DIR="$HOME/aloud"
fi

info()  { printf "\n  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

# When piped from curl, bash reads the script from stdin.
# Do NOT use `exec < /dev/tty` — that would redirect stdin away from
# the pipe and bash would hang trying to read the script from the terminal.
# Instead, individual `read` calls use `< /dev/tty` for interactive input.

OS="$(uname -s)"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       aloud — Setup                 ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── If already set up, offer choices ─────────

if [ -d "$ALOUD_DIR" ]; then
    echo "  aloud is set up at $ALOUD_DIR"
    echo ""
    echo "    1) Update       — pull latest changes and re-run setup"
    echo "    2) Uninstall    — remove aloud and downloaded models"
    echo "    3) Cancel"
    echo ""
    printf "  Choice [1]: "
    read -r ACTION < /dev/tty
    ACTION="${ACTION:-1}"

    if [ "$ACTION" = "3" ]; then
        echo ""; exit 0
    elif [ "$ACTION" = "2" ]; then
        cd "$ALOUD_DIR"
        ./scripts/uninstall.sh
        exit 0
    else
        cd "$ALOUD_DIR"
        info "Updating..."
        git pull
        ok "Updated"
        info "Starting aloud..."
        ./scripts/start.sh --open
        exit 0
    fi
fi

# ── Fresh setup ───────────────────────────────

# Check git
if ! command -v git &>/dev/null; then
    if [ "$OS" = "Darwin" ]; then
        info "git not found — triggering Xcode Command Line Tools setup..."
        echo "  A dialog should appear. Click 'Install', then re-run this script."
        xcode-select --install 2>/dev/null || true
        exit 1
    else
        err "git not found. Install git and re-run this script."
    fi
fi

# Choose location
echo "  Where would you like to set up aloud?"
echo ""
echo "    1) $ALOUD_DIR (default)"
echo "    2) Current directory ($(pwd)/aloud)"
echo "    3) Custom path"
echo ""
printf "  Choice [1]: "
read -r LOC_CHOICE < /dev/tty
LOC_CHOICE="${LOC_CHOICE:-1}"

if [ "$LOC_CHOICE" = "2" ]; then
    ALOUD_DIR="$(pwd)/aloud"
elif [ "$LOC_CHOICE" = "3" ]; then
    printf "  Install path: "
    read -r CUSTOM_PATH < /dev/tty
    if [ -z "$CUSTOM_PATH" ]; then
        err "No path provided."
    fi
    # Expand ~ manually since read doesn't do shell expansion
    CUSTOM_PATH="${CUSTOM_PATH/#\~/$HOME}"
    ALOUD_DIR="$CUSTOM_PATH"
fi

# Clone
info "Cloning aloud to $ALOUD_DIR..."
git clone "$REPO_URL" "$ALOUD_DIR"
ok "Cloned"

cd "$ALOUD_DIR"

# Save path so future runs can find it
echo "$ALOUD_DIR" > "$BREADCRUMB"

# Start (bootstraps on first run)
info "Starting aloud..."
./scripts/start.sh --open

# macOS extras: Desktop app + remove quarantine
if [ "$OS" = "Darwin" ] && [ -d "aloud.app" ]; then
    info "Copying aloud.app to Desktop..."
    DESKTOP_APP="$HOME/Desktop/aloud.app"
    cp -R aloud.app "$DESKTOP_APP"

    # Write breadcrumb so the app knows where the project lives
    mkdir -p "$DESKTOP_APP/Contents/Resources"
    echo "$ALOUD_DIR" > "$DESKTOP_APP/Contents/Resources/.aloud-project-path"

    # Remove quarantine so it opens without Gatekeeper warning
    xattr -dr com.apple.quarantine "$DESKTOP_APP" 2>/dev/null || true

    ok "aloud.app added to Desktop"
fi

# ── Done ─────────────────────────────────────────

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║          Setup Complete!             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  To start again later:"
if [ "$OS" = "Darwin" ]; then
    echo "    • Double-click aloud on your Desktop"
    echo "    • Or: cd $ALOUD_DIR && ./scripts/start.sh"
else
    echo "    cd $ALOUD_DIR && ./scripts/start.sh --open"
fi
echo ""

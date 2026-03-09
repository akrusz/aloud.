#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Glooow — Easy installer
# Usage: curl -fsSL https://raw.githubusercontent.com/akrusz/glooow/main/scripts/install-easy.sh | bash
# ─────────────────────────────────────────────────

GLOOOW_DIR="${GLOOOW_DIR:-$HOME/glooow}"
REPO_URL="https://github.com/akrusz/glooow.git"

info()  { printf "\n  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

# Allow interactive prompts even when piped from curl
if [ ! -t 0 ] && [ -e /dev/tty ]; then
    exec < /dev/tty
fi

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       Glooow — Easy Install          ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Check git ────────────────────────────────────

if ! command -v git &>/dev/null; then
    OS="$(uname -s)"
    if [ "$OS" = "Darwin" ]; then
        info "git not found — triggering Xcode Command Line Tools install..."
        echo "  A dialog should appear. Click 'Install', then re-run this script."
        xcode-select --install 2>/dev/null || true
        exit 1
    else
        err "git not found. Install git and re-run this script."
    fi
fi

# ── Clone or update ──────────────────────────────

if [ -d "$GLOOOW_DIR" ]; then
    info "glooow already exists at $GLOOOW_DIR"
    printf "  Update with git pull? [Y/n]: "
    read -r PULL_ANSWER
    PULL_ANSWER="${PULL_ANSWER:-Y}"
    if [ "$PULL_ANSWER" = "Y" ] || [ "$PULL_ANSWER" = "y" ]; then
        cd "$GLOOOW_DIR"
        git pull
        ok "Updated"
    fi
else
    info "Cloning glooow to $GLOOOW_DIR..."
    git clone "$REPO_URL" "$GLOOOW_DIR"
    ok "Cloned"
fi

cd "$GLOOOW_DIR"

# ── Run install.sh ───────────────────────────────

info "Running installer..."
./scripts/install.sh

# ── macOS extras: Desktop app + remove quarantine

OS="$(uname -s)"
if [ "$OS" = "Darwin" ] && [ -d "Glooow.app" ]; then
    info "Copying Glooow.app to Desktop..."
    DESKTOP_APP="$HOME/Desktop/Glooow.app"
    cp -R Glooow.app "$DESKTOP_APP"

    # Write breadcrumb so the app knows where the project lives
    mkdir -p "$DESKTOP_APP/Contents/Resources"
    echo "$GLOOOW_DIR" > "$DESKTOP_APP/Contents/Resources/.glooow-project-path"

    # Remove quarantine so it opens without Gatekeeper warning
    xattr -dr com.apple.quarantine "$DESKTOP_APP" 2>/dev/null || true

    ok "Glooow.app added to Desktop"
fi

# ── Done ─────────────────────────────────────────

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║          Install Complete!           ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  To start:"
if [ "$OS" = "Darwin" ]; then
    echo "    • Double-click Glooow on your Desktop"
    echo "    • Or: cd $GLOOOW_DIR && ./scripts/start.sh"
else
    echo "    cd $GLOOOW_DIR && ./scripts/start.sh --open"
fi
echo ""

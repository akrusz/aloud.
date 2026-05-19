#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# aloud — Uninstaller
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

CONFIG_FILE="config/default.yaml"

# ── Helpers ──────────────────────────────────────

info()  { printf "\n  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }

ask_yn() {
    local prompt="$1" default="$2"
    printf "  %s [%s]: " "$prompt" "$default" >&2
    read -r answer < /dev/tty
    answer="${answer:-$default}"
    [ "$answer" = "Y" ] || [ "$answer" = "y" ]
}

OS="$(uname -s)"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       aloud — Uninstall             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Remove Ollama models ────────────────────────

if command -v ollama &>/dev/null; then
    # Read model from config if it exists
    OLLAMA_MODEL=""
    if [ -f "$CONFIG_FILE" ]; then
        OLLAMA_MODEL=$(grep -E '^\s+ollama_model:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || true)
    fi

    # Check which aloud-related models are installed
    INSTALLED_MODELS=()
    if [ -n "$OLLAMA_MODEL" ]; then
        MODEL_BASE=$(echo "$OLLAMA_MODEL" | cut -d: -f1)
        while IFS= read -r line; do
            INSTALLED_MODELS+=("$line")
        done < <(ollama list 2>/dev/null | grep -i "$MODEL_BASE" | awk '{print $1}' || true)
    fi

    if [ ${#INSTALLED_MODELS[@]} -gt 0 ]; then
        info "Found Ollama model(s) used by aloud:"
        for m in "${INSTALLED_MODELS[@]}"; do
            echo "    $m"
        done
        echo ""
        if ask_yn "Remove these models?" "Y"; then
            for m in "${INSTALLED_MODELS[@]}"; do
                ollama rm "$m" 2>/dev/null || true
                ok "Removed $m"
            done
        fi
    fi

    echo ""
    if ask_yn "Uninstall Ollama itself?" "n"; then
        if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
            brew uninstall ollama 2>/dev/null || true
            ok "Ollama uninstalled via Homebrew"
        elif [ "$OS" = "Linux" ]; then
            sudo rm -f /usr/local/bin/ollama 2>/dev/null || true
            sudo rm -rf /usr/local/lib/ollama 2>/dev/null || true
            sudo systemctl stop ollama 2>/dev/null || true
            sudo systemctl disable ollama 2>/dev/null || true
            sudo rm -f /etc/systemd/system/ollama.service 2>/dev/null || true
            ok "Ollama uninstalled"
        else
            warn "Could not auto-uninstall Ollama on this platform. Remove it manually."
        fi
        if [ -d "$HOME/.ollama" ]; then
            if ask_yn "Remove Ollama data directory (~/.ollama)? This deletes ALL models" "n"; then
                rm -rf "$HOME/.ollama"
                ok "Removed ~/.ollama"
            fi
        fi
    fi
fi

# ── Remove Whisper model cache ──────────────────

WHISPER_CACHE="$HOME/.cache/whisper"
if [ -d "$WHISPER_CACHE" ]; then
    info "Found Whisper model cache at $WHISPER_CACHE"
    CACHE_SIZE=$(du -sh "$WHISPER_CACHE" 2>/dev/null | awk '{print $1}')
    echo "    Size: $CACHE_SIZE"
    if ask_yn "Remove Whisper cache?" "Y"; then
        rm -rf "$WHISPER_CACHE"
        ok "Removed Whisper cache"
    fi
fi

# ── Remove Python virtual environment ───────────

if [ -d ".venv" ]; then
    info "Removing Python virtual environment..."
    rm -rf .venv
    ok "Removed .venv"
fi

# ── Remove config ───────────────────────────────

if [ -f "$CONFIG_FILE" ]; then
    info "Removing configuration..."
    rm -f "$CONFIG_FILE"
    ok "Removed $CONFIG_FILE"
fi

# ── Remove saved sessions ───────────────────────

if [ -d "sessions" ]; then
    SESSION_COUNT=$(find sessions -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    if [ "$SESSION_COUNT" -gt 0 ]; then
        info "Found $SESSION_COUNT saved session(s) in sessions/"
        if ask_yn "Remove saved sessions?" "n"; then
            rm -rf sessions
            ok "Removed sessions/"
        else
            ok "Kept sessions/"
        fi
    fi
fi

# ── Remove install breadcrumb ────────────────────

BREADCRUMB="$HOME/.aloud-path"
if [ -f "$BREADCRUMB" ]; then
    rm -f "$BREADCRUMB"
    ok "Removed $BREADCRUMB"
fi

# ── Remove macOS Desktop app ────────────────────

if [ "$OS" = "Darwin" ]; then
    DESKTOP_APP="$HOME/Desktop/aloud.app"
    if [ -d "$DESKTOP_APP" ]; then
        info "Removing Desktop app..."
        rm -rf "$DESKTOP_APP"
        ok "Removed $DESKTOP_APP"
    fi
fi

# ── Remove project directory ────────────────────

PROJECT_DIR="$(pwd)"
echo ""
if ask_yn "Remove the aloud project directory ($PROJECT_DIR)?" "n"; then
    echo ""
    warn "This will delete the entire project directory."
    if ask_yn "Are you sure?" "n"; then
        cd "$HOME"
        rm -rf "$PROJECT_DIR"
        ok "Removed $PROJECT_DIR"
        echo ""
        echo "  aloud has been completely removed."
        if [ "${ALOUD_APP:-}" = "1" ]; then
            echo ""
            echo "  You can close this window."
        fi
        echo ""
        exit 0
    fi
fi

# ── Done ─────────────────────────────────────────

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║        Uninstall Complete!           ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Note: uv and Homebrew were left in place (shared tools)."
if [ "${ALOUD_APP:-}" = "1" ]; then
    echo ""
    echo "  You can close this window."
fi
echo ""

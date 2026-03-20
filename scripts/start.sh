#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Glooow — Launch script
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

AUTO_OPEN=""
for arg in "$@"; do
    case "$arg" in
        --open) AUTO_OPEN=1 ;;
    esac
done

CONFIG_FILE="config/default.yaml"
PROXY_PID=""

# ── Helpers ──────────────────────────────────────

info()  { printf "  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

# ── Check uv ─────────────────────────────────────

if ! command -v uv &>/dev/null; then
    err "uv not found. Run ./scripts/setup-local.sh first or install uv: https://docs.astral.sh/uv/"
fi

# ── Read config values ───────────────────────────

if [ ! -f "$CONFIG_FILE" ]; then
    err "Config not found at $CONFIG_FILE. Run ./scripts/setup-local.sh first."
fi

# Extract key values from YAML (simple grep — avoids needing yq)
LLM_PROVIDER=$(grep '^\s*provider:' "$CONFIG_FILE" | head -1 | sed 's/.*provider:\s*//' | sed 's/\s*#.*//')
LLM_MODEL=$(grep '^\s*model:' "$CONFIG_FILE" | head -1 | sed 's/.*model:\s*//' | sed 's/\s*#.*//')
OLLAMA_MODEL=$(grep '^\s*ollama_model:' "$CONFIG_FILE" | head -1 | sed 's/.*ollama_model:\s*//' | sed 's/\s*#.*//')
TTS_ENGINE=$(grep '^\s*engine:' "$CONFIG_FILE" | head -2 | tail -1 | sed 's/.*engine:\s*//' | sed 's/\s*#.*//')
PROXY_URL=$(grep '^\s*proxy_url:' "$CONFIG_FILE" | head -1 | sed 's/.*proxy_url:\s*//' | sed 's/\s*#.*//')
OLLAMA_URL=$(grep '^\s*ollama_url:' "$CONFIG_FILE" | head -1 | sed 's/.*ollama_url:\s*//' | sed 's/\s*#.*//')
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

# ── Cleanup on exit ─────────────────────────────

cleanup() {
    echo ""
    info "Shutting down..."
    if [ -n "$PROXY_PID" ]; then
        info "Stopping CLIProxyAPI (pid $PROXY_PID)..."
        kill "$PROXY_PID" 2>/dev/null || true
        wait "$PROXY_PID" 2>/dev/null || true
        ok "CLIProxyAPI stopped"
    fi
    ok "Done."
    if [ "${GLOOOW_APP:-}" = "1" ]; then
        echo ""
        echo "  You can close this window."
        echo ""
    fi
}
trap cleanup EXIT INT TERM

# ── Startup banner ───────────────────────────────

if [ "${QUIET:-}" != "1" ]; then
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo "  ║       Glooow                         ║"
    echo "  ╚══════════════════════════════════════╝"
    echo ""
    if [ "$LLM_PROVIDER" = "ollama" ] && [ -n "$OLLAMA_MODEL" ]; then
        DISPLAY_MODEL="$OLLAMA_MODEL"
    else
        DISPLAY_MODEL="$LLM_MODEL"
    fi
    info "LLM:    $LLM_PROVIDER ($DISPLAY_MODEL)"
    info "TTS:    $TTS_ENGINE"
    info "Config: $CONFIG_FILE"

    OS="$(uname -s)"
    if [ "$OS" = "Linux" ] && [ "$TTS_ENGINE" != "piper" ]; then
        echo ""
        warn "For server-side TTS on Linux, install piper-tts:"
        warn "  uv pip install piper-tts"
        warn "  Then set tts.engine to 'piper' in $CONFIG_FILE"
    fi
    echo ""
fi

# ── Auto-start CLIProxyAPI if needed ─────────────

if [ "$LLM_PROVIDER" = "claude_proxy" ]; then
    # Extract port from proxy_url
    PROXY_PORT=$(echo "$PROXY_URL" | grep -oE ':[0-9]+$' | tr -d ':')
    PROXY_PORT="${PROXY_PORT:-8317}"

    if curl -sf "http://127.0.0.1:${PROXY_PORT}/v1/models" >/dev/null 2>&1; then
        ok "CLIProxyAPI already running on port $PROXY_PORT"
    elif command -v CLIProxyAPI &>/dev/null; then
        info "Starting CLIProxyAPI on port $PROXY_PORT..."
        CLIProxyAPI &
        PROXY_PID=$!

        for i in $(seq 1 20); do
            if curl -sf "http://127.0.0.1:${PROXY_PORT}/v1/models" >/dev/null 2>&1; then
                ok "CLIProxyAPI ready (pid $PROXY_PID)"
                break
            fi
            if [ "$i" -eq 20 ]; then
                warn "CLIProxyAPI didn't respond in 10s — it may still be loading"
            fi
            sleep 0.5
        done
    fi
fi

# ── Auto-start Ollama if needed ──────────────────

if [ "$LLM_PROVIDER" = "ollama" ]; then
    if curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
        ok "Ollama running"
    elif command -v ollama &>/dev/null; then
        info "Starting Ollama..."
        OS="$(uname -s)"
        if [ "$OS" = "Darwin" ]; then
            open -a Ollama 2>/dev/null || ollama serve &>/dev/null &
        else
            ollama serve &>/dev/null &
        fi
        for i in $(seq 1 20); do
            if curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
                ok "Ollama ready"
                break
            fi
            if [ "$i" -eq 20 ]; then
                warn "Ollama didn't respond in 10s — it may still be loading"
            fi
            sleep 0.5
        done
    fi
fi

# ── Launch the web app ───────────────────────────

info "Starting Glooow web server..."
echo ""

GLOOOW_AUTO_OPEN="${AUTO_OPEN}" uv run python -m src.web

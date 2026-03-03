#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Glooow — Launch script
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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
    err "uv not found. Run ./install.sh first or install uv: https://docs.astral.sh/uv/"
fi

# ── Read config values ───────────────────────────

if [ ! -f "$CONFIG_FILE" ]; then
    err "Config not found at $CONFIG_FILE. Run ./install.sh first."
fi

# Extract key values from YAML (simple grep — avoids needing yq)
LLM_PROVIDER=$(grep '^\s*provider:' "$CONFIG_FILE" | head -1 | sed 's/.*provider:\s*//' | sed 's/\s*#.*//')
LLM_MODEL=$(grep '^\s*model:' "$CONFIG_FILE" | head -1 | sed 's/.*model:\s*//' | sed 's/\s*#.*//')
TTS_ENGINE=$(grep '^\s*engine:' "$CONFIG_FILE" | head -2 | tail -1 | sed 's/.*engine:\s*//' | sed 's/\s*#.*//')
PROXY_URL=$(grep '^\s*proxy_url:' "$CONFIG_FILE" | head -1 | sed 's/.*proxy_url:\s*//' | sed 's/\s*#.*//')

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
}
trap cleanup EXIT INT TERM

# ── Startup banner ───────────────────────────────

if [ "${QUIET:-}" != "1" ]; then
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo "  ║       Glooow                          ║"
    echo "  ╚══════════════════════════════════════╝"
    echo ""
    info "LLM:    $LLM_PROVIDER ($LLM_MODEL)"
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
    else
        if command -v CLIProxyAPI &>/dev/null; then
            info "Starting CLIProxyAPI on port $PROXY_PORT..."
            CLIProxyAPI &
            PROXY_PID=$!

            # Wait for it to be ready (up to 10 seconds)
            for i in $(seq 1 20); do
                if curl -sf "http://127.0.0.1:${PROXY_PORT}/v1/models" >/dev/null 2>&1; then
                    ok "CLIProxyAPI ready (pid $PROXY_PID)"
                    break
                fi
                if [ "$i" -eq 20 ]; then
                    err "CLIProxyAPI failed to start within 10 seconds."
                fi
                sleep 0.5
            done
        else
            echo ""
            err "CLIProxyAPI not found. Install it or switch to Ollama in $CONFIG_FILE."
        fi
    fi
fi

# ── Launch the web app ───────────────────────────

info "Starting Glooow web server..."
echo ""

GLOOOW_AUTO_OPEN="${AUTO_OPEN}" uv run python -m src.web

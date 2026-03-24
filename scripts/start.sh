#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Glooow — Launch script (with first-run bootstrap)
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
OS="$(uname -s)"

# ── Helpers ──────────────────────────────────────

info()  { printf "  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

# ── Bootstrap functions ──────────────────────────

ensure_uv() {
    if command -v uv &>/dev/null; then
        return
    fi
    echo ""
    info "uv (Python package manager) is not installed."
    echo "  uv is needed to manage Python packages for glooow."
    echo ""
    printf "  Install uv now? [Y/n]: " >&2
    read -r answer < /dev/tty
    answer="${answer:-Y}"
    if [ "$answer" = "Y" ] || [ "$answer" = "y" ]; then
        info "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
        if ! command -v uv &>/dev/null; then
            err "uv installation failed. Install manually: https://docs.astral.sh/uv/"
        fi
        ok "uv installed"
    else
        err "uv is required. Install it: https://docs.astral.sh/uv/getting-started/installation/"
    fi
}

ensure_system_deps() {
    if [ "$OS" = "Darwin" ]; then
        # macOS — portaudio via Homebrew
        if ! command -v brew &>/dev/null; then
            warn "Homebrew not found. PortAudio is needed for audio input."
            warn "Install Homebrew (https://brew.sh), then run: brew install portaudio"
        elif ! brew list portaudio &>/dev/null 2>&1; then
            info "Installing portaudio via Homebrew..."
            brew install portaudio
            ok "portaudio installed"
        fi
    elif [ "$OS" = "Linux" ]; then
        # Check if portaudio is already available
        if pkg-config --exists portaudio-2.0 2>/dev/null || ldconfig -p 2>/dev/null | grep -q libportaudio; then
            return
        fi

        echo ""
        warn "PortAudio is needed for audio input but was not detected."
        echo ""

        if command -v apt-get &>/dev/null; then
            PKG_CMD="sudo apt-get install -y portaudio19-dev python3-dev"
        elif command -v dnf &>/dev/null; then
            PKG_CMD="sudo dnf install -y portaudio-devel python3-devel"
        elif command -v pacman &>/dev/null; then
            PKG_CMD="sudo pacman -S --noconfirm portaudio"
        else
            warn "Could not detect your package manager."
            warn "Please install PortAudio manually, then re-run this script."
            return
        fi

        echo "  To install it manually, run:"
        echo ""
        echo "    $PKG_CMD"
        echo ""
        printf "  Run this command now? [Y/n]: " >&2
        read -r answer < /dev/tty
        answer="${answer:-Y}"
        if [ "$answer" = "Y" ] || [ "$answer" = "y" ]; then
            eval "$PKG_CMD"
            ok "System dependencies installed"
        else
            warn "Skipping — you can install it later with the command above."
            warn "Audio input may not work until PortAudio is installed."
        fi
    fi
}

ensure_venv() {
    # $REQUIREMENTS_FILE is set during first-run bootstrap (see below)
    local req="${REQUIREMENTS_FILE:-requirements.txt}"

    if [ -d ".venv" ]; then
        # Check if deps need updating (requirements file newer than venv)
        if [ "$req" -nt .venv/pyvenv.cfg ] 2>/dev/null; then
            info "Dependencies updated — installing..."
            uv pip install --quiet -r "$req"
            ok "Dependencies updated"
        fi
        return
    fi

    info "Creating Python environment..."
    uv venv --quiet --python ">=3.10" .venv 2>/dev/null || uv venv --quiet .venv
    info "Installing Python dependencies (this may take a minute)..."
    uv pip install --quiet -r "$req"
    ok "Python dependencies installed"
}

ensure_config() {
    if [ -f "$CONFIG_FILE" ]; then
        return
    fi

    info "Writing default configuration..."
    mkdir -p config

    cat > "$CONFIG_FILE" << 'YAML'
audio:
  input_device: default
  sample_rate: 16000
  channels: 1
  chunk_size: 480  # 30ms at 16kHz
  vad_sensitivity: 2  # 0-3, higher = more sensitive

stt:
  engine: whisper
  model: small  # tiny, base, small, medium, large
  language: en
  device: auto  # auto, cpu, cuda, mps

tts:
  # Engine options:
  #   macos   -- macOS native 'say' command (macOS only)
  #   piper   -- Piper neural TTS (pip install piper-tts)
  #   browser -- no server-side audio; falls back to browser speechSynthesis
  engine: browser
  voice: "Zoe (Premium)"
  rate: 120  # words per minute

llm:
  provider: ollama  # ollama, claude_proxy, anthropic, openai, openrouter, venice
  model: claude-sonnet-4-6

  # API key — uses env var substitution so keys stay out of the file.
  # Set the matching env var for your provider:
  #   anthropic:   ANTHROPIC_API_KEY
  #   openai:      OPENAI_API_KEY
  #   openrouter:  OPENROUTER_API_KEY
  #   venice:      VENICE_API_KEY
  #   claude_proxy: uses the fixed key below (localhost only)
  # api_key: ${ANTHROPIC_API_KEY}

  # For claude_proxy (CLIProxyAPI)
  proxy_url: http://127.0.0.1:8317

  # For Ollama
  ollama_url: http://localhost:11434
  ollama_model: qwen3.5:4b

  # Recommended Ollama model tiers (shown in settings UI).
  ollama_tiers:
    - model: "qwen3.5:35b-a3b"
      label: Best
      min_gb: 24
      download: "~20GB"
      disk: "~20GB"
      ram: "~22GB"
      note: "Large model but uses a clever trick to stay fast. Best quality by far"
    - model: "qwen3.5:9b"
      label: Better
      min_gb: 16
      download: "~5.5GB"
      disk: "~5.5GB"
      ram: "~9GB"
      note: "Slower responses than 4B but noticeably higher quality"
    - model: "qwen3.5:4b"
      label: Good
      min_gb: 0
      download: "~2.5GB"
      disk: "~2.5GB"
      ram: "~5GB"
      note: "Fast on any hardware"

  context:
    strategy: full  # full, rolling
    window_size: 100   # exchanges to keep (if rolling)
    max_tokens: 400    # max response tokens

pacing:
  response_delay_ms: 2000       # wait after speech ends before responding
  min_speech_duration_ms: 500   # ignore very short sounds
  extended_silence_sec: 300     # when to offer gentle check-in

facilitation:
  directiveness: 3          # 0-10 scale
  focuses: []               # body_sensations, emotions, inner_parts
  qualities: []             # playful, compassionate, loving, spacious, effortless, feeling_good
  verbosity: medium         # low, medium, high
  custom_instructions: |
    Feel free to suggest releasing the need to pay attention to anything specific.
    Trust the meditator's process.

session:
  auto_save: true
  save_directory: sessions
  include_timestamps: true
YAML

    ok "Config written to $CONFIG_FILE"
}

# ── First-run bootstrap ─────────────────────────

ensure_uv

REQUIREMENTS_FILE="requirements.txt"

if [ ! -d ".venv" ] || [ ! -f "$CONFIG_FILE" ]; then
    echo ""
    echo "  ╔══════════════════════════════════════╗"
    echo "  ║       Glooow — First-time setup      ║"
    echo "  ╚══════════════════════════════════════╝"
    echo ""

    # Ask about install mode
    echo "  How would you like to run glooow?"
    echo ""
    echo "    App     — native window (default)"
    echo "    Browser — lightweight, opens in your browser"
    echo ""
    printf "  Press Enter for app, or B for browser-only: " >&2
    read -r INSTALL_MODE < /dev/tty
    if [ "$INSTALL_MODE" = "b" ] || [ "$INSTALL_MODE" = "B" ]; then
        REQUIREMENTS_FILE="requirements-browser.txt"
        info "Installing in browser-only mode (lighter dependencies)"
    else
        info "Installing full app with native window"
    fi
    echo ""
    ensure_system_deps
    ensure_venv
    ensure_config
    echo ""
    ok "Setup complete! You can configure your LLM provider and"
    ok "other settings in the web interface once it opens."
    echo ""
else
    # Not first run — just check if deps need refreshing
    ensure_venv
fi

# ── Read config values ───────────────────────────

# Extract key values from YAML (simple grep — avoids needing yq)
# The trailing sed trims leading/trailing whitespace from values.
LLM_PROVIDER=$(grep '^\s*provider:' "$CONFIG_FILE" | head -1 | sed 's/.*provider:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
LLM_MODEL=$(grep '^\s*model:' "$CONFIG_FILE" | head -1 | sed 's/.*model:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
OLLAMA_MODEL=$(grep '^\s*ollama_model:' "$CONFIG_FILE" | head -1 | sed 's/.*ollama_model:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
TTS_ENGINE=$(grep '^\s*engine:' "$CONFIG_FILE" | head -2 | tail -1 | sed 's/.*engine:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
PROXY_URL=$(grep '^\s*proxy_url:' "$CONFIG_FILE" | head -1 | sed 's/.*proxy_url:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
OLLAMA_URL=$(grep '^\s*ollama_url:' "$CONFIG_FILE" | head -1 | sed 's/.*ollama_url:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

# ── Cleanup on exit ─────────────────────────────

CLEANED_UP=0
cleanup() {
    [ "$CLEANED_UP" = "1" ] && return
    CLEANED_UP=1
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
    echo "  ║              glooow                  ║"
    echo "  ╚══════════════════════════════════════╝"
    if [ "$LLM_PROVIDER" = "ollama" ] && [ -n "$OLLAMA_MODEL" ]; then
        DISPLAY_MODEL="$OLLAMA_MODEL"
    else
        DISPLAY_MODEL="$LLM_MODEL"
    fi
    info "LLM:    $LLM_PROVIDER ($DISPLAY_MODEL)"
    info "TTS:    $TTS_ENGINE"
    info "Config: $CONFIG_FILE"
    echo ""
fi

# ── Auto-start CLIProxyAPI if needed ─────────────

if [ "$LLM_PROVIDER" = "claude_proxy" ]; then
    # Extract port and API key for health checks
    PROXY_PORT=$(echo "$PROXY_URL" | grep -oE ':[0-9]+$' | tr -d ':')
    PROXY_PORT="${PROXY_PORT:-8317}"
    PROXY_API_KEY=$(grep '^\s*api_key:' "$CONFIG_FILE" | head -1 | sed 's/.*api_key:\s*//' | sed 's/\s*#.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    PROXY_CURL_OPTS=(-sf)
    if [ -n "$PROXY_API_KEY" ] && [[ ! "$PROXY_API_KEY" =~ ^\$ ]]; then
        PROXY_CURL_OPTS+=(-H "X-Api-Key: $PROXY_API_KEY")
    fi

    if curl "${PROXY_CURL_OPTS[@]}" "http://127.0.0.1:${PROXY_PORT}/v1/models" >/dev/null 2>&1; then
        ok "CLIProxyAPI already running on port $PROXY_PORT"
    elif command -v CLIProxyAPI &>/dev/null; then
        info "Starting CLIProxyAPI on port $PROXY_PORT..."
        CLIProxyAPI >/dev/null 2>&1 &
        PROXY_PID=$!

        for i in $(seq 1 20); do
            if curl "${PROXY_CURL_OPTS[@]}" "http://127.0.0.1:${PROXY_PORT}/v1/models" >/dev/null 2>&1; then
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

GLOOOW_AUTO_OPEN="${AUTO_OPEN}" uv run python -m src.web

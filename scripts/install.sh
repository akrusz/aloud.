#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Glooow — First-time setup
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

VENV_DIR=".venv"
CONFIG_FILE="config/default.yaml"

# ── Helpers ──────────────────────────────────────

info()  { printf "\n  \033[1;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[1;31m✗\033[0m %s\n" "$*"; }

ask() {
    # ask PROMPT DEFAULT → prints answer
    # Reads from /dev/tty so it works when piped from curl
    local prompt="$1" default="$2"
    printf "  %s [%s]: " "$prompt" "$default" >&2
    read -r answer < /dev/tty
    echo "${answer:-$default}"
}

OS="$(uname -s)"

# ── Pre-flight checks ───────────────────────────

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       Glooow — Setup                 ║"
echo "  ╚══════════════════════════════════════╝"

# uv
info "Checking uv..."
if ! command -v uv &>/dev/null; then
    warn "uv not found. uv is a fast Python package manager needed to run glooow."
    echo ""
    printf "  Install uv now? [Y/n]: " >&2
    read -r INSTALL_UV < /dev/tty
    INSTALL_UV="${INSTALL_UV:-Y}"
    if [ "$INSTALL_UV" = "Y" ] || [ "$INSTALL_UV" = "y" ]; then
        info "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        # Source the env so uv is available in this session
        export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
        if ! command -v uv &>/dev/null; then
            err "uv installation failed. Install manually: https://docs.astral.sh/uv/getting-started/installation/"
            exit 1
        fi
        ok "uv installed"
    else
        err "uv is required. Install it: https://docs.astral.sh/uv/getting-started/installation/"
        exit 1
    fi
fi
ok "uv $(uv --version | awk '{print $2}')"

# ── System dependencies ─────────────────────────

info "Installing system dependencies..."

if [ "$OS" = "Darwin" ]; then
    # macOS — needs Homebrew for portaudio
    if ! command -v brew &>/dev/null; then
        warn "Homebrew not found. PortAudio is needed for audio input."
        warn "Install Homebrew: https://brew.sh"
        warn "Then run: brew install portaudio"
    elif ! brew list portaudio &>/dev/null 2>&1; then
        echo "  Installing portaudio via Homebrew..."
        brew install portaudio
        ok "portaudio installed"
    else
        ok "portaudio already installed"
    fi
elif [ "$OS" = "Linux" ]; then
    # Linux — Debian/Ubuntu
    if command -v apt-get &>/dev/null; then
        echo "  Installing portaudio19-dev, python3-dev (may need sudo)..."
        sudo apt-get install -y portaudio19-dev python3-dev
        ok "System packages installed"
    else
        warn "Non-Debian system detected. Please install PortAudio manually."
        warn "  Fedora/RHEL: sudo dnf install portaudio-devel"
        warn "  Arch: sudo pacman -S portaudio"
    fi
else
    warn "Unknown OS: $OS — skipping system dependency install."
fi

# ── LLM provider choice ─────────────────────────

info "Configuring LLM provider..."
echo ""
echo "  How would you like to power the AI?"
echo ""
echo "    1) Claude       — best quality, needs a Claude subscription + CLIProxyAPI"
echo "    2) Local (Ollama) — runs on your computer, no account needed (~2.5GB download)"
echo "    3) Venice.ai    — cloud-based, privacy-focused"
echo ""
LLM_CHOICE=$(ask "Choice" "1")

LLM_PROVIDER="claude_proxy"
LLM_MODEL="claude-sonnet-4-5-20250929"
PROXY_URL="http://127.0.0.1:8317"
API_KEY="glooow"
OLLAMA_URL="http://localhost:11434"
OLLAMA_MODEL="qwen3.5:4b"

if [ "$LLM_CHOICE" = "2" ]; then
    LLM_PROVIDER="ollama"

    # ── Install Ollama if needed ──────────────────
    if ! command -v ollama &>/dev/null; then
        echo ""
        echo "  Ollama is a small app (~200MB) that runs AI models on your computer."
        echo "  It's free, open source, and your data never leaves your machine."
        echo ""

        if [ "$OS" = "Darwin" ]; then
            if command -v brew &>/dev/null; then
                printf "  Install Ollama via Homebrew? [Y/n]: " >&2
                read -r INSTALL_OLLAMA < /dev/tty
                INSTALL_OLLAMA="${INSTALL_OLLAMA:-Y}"
                if [ "$INSTALL_OLLAMA" = "Y" ] || [ "$INSTALL_OLLAMA" = "y" ]; then
                    info "Installing Ollama (this may take a minute)..."
                    brew install ollama
                    ok "Ollama installed"
                else
                    echo ""
                    err "Ollama is needed for local mode. Install from https://ollama.ai and re-run."
                fi
            else
                echo "  To use local mode, install Ollama from https://ollama.ai"
                echo "  then re-run this script."
                exit 1
            fi
        else
            # Linux — use the official install script
            printf "  Install Ollama now? [Y/n]: " >&2
            read -r INSTALL_OLLAMA
            INSTALL_OLLAMA="${INSTALL_OLLAMA:-Y}"
            if [ "$INSTALL_OLLAMA" = "Y" ] || [ "$INSTALL_OLLAMA" = "y" ]; then
                info "Installing Ollama..."
                curl -fsSL https://ollama.com/install.sh | sh
                ok "Ollama installed"
            else
                echo ""
                err "Ollama is needed for local mode. Install from https://ollama.ai and re-run."
            fi
        fi
    else
        ok "Ollama already installed"
    fi

    # ── Start Ollama if not running ───────────────
    if ! curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
        info "Starting Ollama..."
        if [ "$OS" = "Darwin" ]; then
            open -a Ollama 2>/dev/null || ollama serve &>/dev/null &
        else
            ollama serve &>/dev/null &
        fi
        for i in $(seq 1 20); do
            if curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
                break
            fi
            if [ "$i" -eq 20 ]; then
                warn "Ollama is taking a while to start — it may still be loading."
            fi
            sleep 0.5
        done
        ok "Ollama running"
    else
        ok "Ollama already running"
    fi

    # ── Download a model ──────────────────────────
    echo ""
    echo "  Now let's download an AI model to run locally."
    echo "  The default is $OLLAMA_MODEL (~2.5GB) — it works well on most"
    echo "  computers with 8GB of RAM or more."
    echo ""
    OLLAMA_MODEL=$(ask "Model" "$OLLAMA_MODEL")

    if ollama list 2>/dev/null | grep -q "$(echo "$OLLAMA_MODEL" | cut -d: -f1)"; then
        ok "$OLLAMA_MODEL already downloaded"
    else
        info "Downloading $OLLAMA_MODEL — this may take a few minutes on the first run..."
        ollama pull "$OLLAMA_MODEL"
        ok "$OLLAMA_MODEL ready"
    fi

    ok "All set! Using local AI with $OLLAMA_MODEL"

elif [ "$LLM_CHOICE" = "3" ]; then
    LLM_PROVIDER="venice"
    LLM_MODEL="llama-3.3-70b"
    printf "  Venice API key: " >&2
    read -r VENICE_KEY < /dev/tty
    if [ -n "$VENICE_KEY" ]; then
        echo "  Add to your shell profile:"
        echo "    export VENICE_API_KEY=\"$VENICE_KEY\""
        export VENICE_API_KEY="$VENICE_KEY"
    fi
    ok "Using Venice.ai with model $LLM_MODEL"
else
    API_KEY=$(ask "CLIProxyAPI key" "$API_KEY")

    # Install CLIProxyAPI if not present
    if ! command -v CLIProxyAPI &>/dev/null; then
        if command -v brew &>/dev/null; then
            info "Installing CLIProxyAPI via Homebrew..."
            brew install cliproxyapi
            ok "CLIProxyAPI installed"
        else
            warn "CLIProxyAPI not found and Homebrew not available."
            warn "Install it manually: https://github.com/CLIProxyAPI/CLIProxyAPI"
        fi
    else
        ok "CLIProxyAPI already installed"
    fi
fi

# ── TTS engine ───────────────────────────────────

info "Detecting TTS engine..."

if [ "$OS" = "Darwin" ]; then
    TTS_ENGINE="macos"
    ok "Using macOS native TTS (say command)"
    echo ""
    echo "  Tip: the default macOS voices are pretty robotic. For a more natural sound,"
    echo "  install a premium voice in System Settings > Accessibility > Spoken Content"
    echo "  > System Voice > Manage Voices. Try \"Zoe (Premium)\" or \"Samantha (Premium)\"."
    echo "  Then set tts.voice in $CONFIG_FILE to match."
else
    TTS_ENGINE="browser"
    ok "Using browser-based speechSynthesis (no server-side TTS on Linux)"
    echo ""
    warn "For higher quality server-side TTS on Linux, consider installing piper-tts:"
    warn "  uv pip install piper-tts"
    warn "  Then set tts.engine to 'piper' in $CONFIG_FILE"
fi

# ── Python dependencies ──────────────────────────

info "Installing Python dependencies..."

uv venv --quiet --python ">=3.10" "$VENV_DIR" 2>/dev/null || true
uv pip install --quiet -r requirements.txt
ok "Python dependencies installed"

# ── Pre-download Whisper model ───────────────────

info "Pre-downloading Whisper model (small)..."
echo "  This is ~500MB on first download — subsequent runs will be instant."
uv run python -c "import whisper; whisper.load_model('small')"
ok "Whisper model ready"

# ── Write config ─────────────────────────────────

info "Writing configuration to $CONFIG_FILE..."

mkdir -p config

cat > "$CONFIG_FILE" << YAML
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
  engine: $TTS_ENGINE
  voice: "Zoe (Premium)"
  rate: 160  # words per minute

  # Parakeet options (if engine: parakeet)
  # model_name: nvidia/parakeet-tts-1.1b
  # backend: transformers  # transformers, nemo, onnx

  # ElevenLabs options (if engine: elevenlabs)
  # api_key: \${ELEVENLABS_API_KEY}
  # voice_id: 21m00Tcm4TlvDq8ikWAM  # Rachel - calm, warm
  # model_id: eleven_monolingual_v1
  # stability: 0.75
  # similarity_boost: 0.75

llm:
  provider: $LLM_PROVIDER  # claude_proxy, anthropic, openai, ollama, openrouter, venice
  model: $LLM_MODEL

  # For claude_proxy (CLIProxyAPI)
  proxy_url: $PROXY_URL
  api_key: $API_KEY

  # For direct Anthropic API
  # api_key: \${ANTHROPIC_API_KEY}

  # For Ollama
  ollama_url: $OLLAMA_URL
  ollama_model: $OLLAMA_MODEL

  context:
    strategy: full  # full, rolling
    window_size: 10    # exchanges to keep (if rolling)
    max_tokens: 300    # max response tokens

pacing:
  response_delay_ms: 2000       # wait after speech ends before responding
  min_speech_duration_ms: 500   # ignore very short sounds
  extended_silence_sec: 300     # when to offer gentle check-in

facilitation:
  directiveness: 3          # 0-10 scale
  focuses: []               # body_sensations, emotions, inner_parts
  qualities: []             # playful, compassionate, loving, spacious, effortless, feeling_good
  verbosity: low            # low, medium, high
  custom_instructions: |
    Feel free to suggest releasing the need to pay attention to anything specific.
    Trust the meditator's process.

session:
  auto_save: true
  save_directory: sessions
  include_timestamps: true
YAML

ok "Config written"

# ── Summary ──────────────────────────────────────

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║          Setup Complete!             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  LLM provider:  $LLM_PROVIDER"
if [ "$LLM_PROVIDER" = "ollama" ]; then
    echo "  Ollama model:  $OLLAMA_MODEL @ $OLLAMA_URL"
elif [ "$LLM_PROVIDER" = "venice" ]; then
    echo "  Venice model:  $LLM_MODEL"
else
    echo "  Proxy URL:     $PROXY_URL"
fi
echo "  TTS engine:    $TTS_ENGINE"
echo "  Config file:   $CONFIG_FILE"
echo "  Python env:    $VENV_DIR/ (managed by uv)"
echo ""
echo "  To start: ./scripts/start.sh"
echo ""

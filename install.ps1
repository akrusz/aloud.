# ─────────────────────────────────────────────────
# Glooow — First-time setup (Windows)
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$VenvDir = ".venv"
$ConfigFile = "config\default.yaml"

function Info($msg)  { Write-Host "`n  > $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Err($msg)   { Write-Host "  X $msg" -ForegroundColor Red; exit 1 }

function Ask($prompt, $default) {
    $answer = Read-Host "  $prompt [$default]"
    if (-not $answer) { return $default } else { return $answer }
}

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |       Glooow - Setup                 |"
Write-Host "  +======================================+"

# ── Check uv ─────────────────────────────────────

Info "Checking uv..."
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Warn "uv not found. uv is a fast Python package manager needed to run glooow."
    $installUv = Read-Host "  Install uv now? [Y/n]"
    if (-not $installUv -or $installUv -eq "Y" -or $installUv -eq "y") {
        Info "Installing uv..."
        irm https://astral.sh/uv/install.ps1 | iex
        $env:PATH = "$HOME\.local\bin;$HOME\.cargo\bin;$env:PATH"
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            Err "uv installation failed. Install manually: https://docs.astral.sh/uv/getting-started/installation/"
        }
        Ok "uv installed"
    } else {
        Err "uv is required. Install it: https://docs.astral.sh/uv/getting-started/installation/"
    }
}
$uvVersion = (uv --version) -replace 'uv ', ''
Ok "uv $uvVersion"

# ── LLM provider choice ─────────────────────────

Info "Configuring LLM provider..."
Write-Host ""
Write-Host "  Which LLM provider will you use?"
Write-Host "    1) CLIProxyAPI - uses your Claude subscription (default)"
Write-Host "    2) Ollama      - local LLM server"
Write-Host "    3) Venice.ai   - privacy-focused cloud inference"
Write-Host ""
$LlmChoice = Ask "Choice" "1"

$LlmProvider = "claude_proxy"
$LlmModel = "claude-sonnet-4-5-20250929"
$ProxyUrl = "http://127.0.0.1:8317"
$ApiKey = "glooow"
$OllamaUrl = "http://localhost:11434"
$OllamaModel = "llama3"

if ($LlmChoice -eq "2") {
    $LlmProvider = "ollama"
    $OllamaUrl = Ask "Ollama URL" $OllamaUrl
    $OllamaModel = Ask "Ollama model" $OllamaModel
    Ok "Using Ollama at $OllamaUrl with model $OllamaModel"
} elseif ($LlmChoice -eq "3") {
    $LlmProvider = "venice"
    $LlmModel = "llama-3.3-70b"
    $VeniceKey = Read-Host "  Venice API key"
    if ($VeniceKey) {
        Write-Host "  Add to your profile:"
        Write-Host "    `$env:VENICE_API_KEY = `"$VeniceKey`""
        $env:VENICE_API_KEY = $VeniceKey
    }
    Ok "Using Venice.ai with model $LlmModel"
} else {
    $ApiKey = Ask "CLIProxyAPI key" $ApiKey
}

# ── TTS engine ───────────────────────────────────

Info "Detecting TTS engine..."
$TtsEngine = "browser"
Ok "Using browser-based speechSynthesis"
Write-Host ""
Write-Host "  Tip: for the best voice quality on Windows, open glooow in Edge."
Write-Host "  Edge has access to Microsoft's natural voices (Ava, Jenny) which"
Write-Host "  sound much better than the default system voices in Chrome/Firefox."

# ── Python dependencies ──────────────────────────

Info "Installing Python dependencies..."
uv venv --quiet --python ">=3.10" $VenvDir 2>$null
uv pip install --quiet -r requirements.txt
Ok "Python dependencies installed"

# ── Pre-download Whisper model ───────────────────

Info "Pre-downloading Whisper model (small)..."
Write-Host "  This is ~500MB on first download - subsequent runs will be instant."
uv run python -c "import whisper; whisper.load_model('small')"
Ok "Whisper model ready"

# ── Write config ─────────────────────────────────

Info "Writing configuration to $ConfigFile..."
New-Item -ItemType Directory -Force -Path "config" | Out-Null

@"
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
  engine: $TtsEngine
  voice: "Zoe (Premium)"
  rate: 160  # words per minute

llm:
  provider: $LlmProvider
  model: $LlmModel
  proxy_url: $ProxyUrl
  api_key: $ApiKey
  ollama_url: $OllamaUrl
  ollama_model: $OllamaModel

  context:
    strategy: full
    window_size: 10
    max_tokens: 300

pacing:
  response_delay_ms: 2000
  min_speech_duration_ms: 500
  extended_silence_sec: 60

facilitation:
  directiveness: 3
  focuses: []
  qualities: []
  verbosity: low
  custom_instructions: |
    Feel free to suggest releasing the need to pay attention to anything specific.
    Trust the meditator's process.

session:
  auto_save: true
  save_directory: sessions
  include_timestamps: true
"@ | Set-Content $ConfigFile -Encoding UTF8

Ok "Config written"

# ── Summary ──────────────────────────────────────

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |          Setup Complete!              |"
Write-Host "  +======================================+"
Write-Host ""
Write-Host "  LLM provider:  $LlmProvider"
if ($LlmProvider -eq "ollama") {
    Write-Host "  Ollama model:  $OllamaModel @ $OllamaUrl"
} elseif ($LlmProvider -eq "venice") {
    Write-Host "  Venice model:  $LlmModel"
} else {
    Write-Host "  Proxy URL:     $ProxyUrl"
}
Write-Host "  TTS engine:    $TtsEngine"
Write-Host "  Config file:   $ConfigFile"
Write-Host "  Python env:    $VenvDir\ (managed by uv)"
Write-Host ""
Write-Host "  To start: .\start.ps1"
Write-Host "    Or double-click Start.bat"
Write-Host ""

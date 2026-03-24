# ─────────────────────────────────────────────────
# Glooow — Launch script (with first-run bootstrap)
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $ScriptDir)

$AutoOpen = $false
foreach ($a in $args) {
    if ($a -eq "--open") { $AutoOpen = $true }
}

$ConfigFile = "config/default.yaml"
$ProxyProcess = $null

# ── Helpers ──────────────────────────────────────

function Info($msg)  { Write-Host "  $([char]0x25B8) $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Err($msg)   { Write-Host "  X $msg" -ForegroundColor Red; exit 1 }

# ── Bootstrap functions ──────────────────────────

function Ensure-Uv {
    if (Get-Command uv -ErrorAction SilentlyContinue) { return }

    Write-Host ""
    Info "uv (Python package manager) is not installed."
    Write-Host "  uv is needed to manage Python packages for glooow."
    Write-Host ""
    $answer = Read-Host "  Install uv now? [Y/n]"
    if (-not $answer -or $answer -eq "Y" -or $answer -eq "y") {
        Info "Installing uv..."
        irm https://astral.sh/uv/install.ps1 | iex
        $env:PATH = "$HOME\.local\bin;$HOME\.cargo\bin;$env:PATH"
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            Err "uv installation failed. Install manually: https://docs.astral.sh/uv/"
        }
        Ok "uv installed"
    } else {
        Err "uv is required. Install it: https://docs.astral.sh/uv/getting-started/installation/"
    }
}

function Ensure-Venv {
    # $RequirementsFile is set during first-run bootstrap (see below)
    if (-not $RequirementsFile) { $RequirementsFile = "requirements.txt" }

    if (Test-Path ".venv") {
        # Check if deps need updating (requirements file newer than venv)
        if ((Test-Path $RequirementsFile) -and (Test-Path ".venv\pyvenv.cfg")) {
            if ((Get-Item $RequirementsFile).LastWriteTime -gt (Get-Item ".venv\pyvenv.cfg").LastWriteTime) {
                Info "Dependencies updated - installing..."
                uv pip install --quiet -r $RequirementsFile
                Ok "Dependencies updated"
            }
        }
        return
    }

    Info "Creating Python environment..."
    uv venv --quiet --python ">=3.10" .venv 2>$null
    Info "Installing Python dependencies (this may take a minute)..."
    uv pip install --quiet -r $RequirementsFile
    Ok "Python dependencies installed"
}

function Ensure-Config {
    if (Test-Path $ConfigFile) { return }

    Info "Writing default configuration..."
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

  # API key - uses env var substitution so keys stay out of the file.
  # Set the matching env var for your provider:
  #   anthropic:   ANTHROPIC_API_KEY
  #   openai:      OPENAI_API_KEY
  #   openrouter:  OPENROUTER_API_KEY
  #   venice:      VENICE_API_KEY
  #   claude_proxy: uses the fixed key below (localhost only)
  # api_key: `${ANTHROPIC_API_KEY}

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
"@ | Set-Content $ConfigFile -Encoding UTF8

    Ok "Config written to $ConfigFile"
}

# ── First-run bootstrap ─────────────────────────

Ensure-Uv

$RequirementsFile = "requirements.txt"

if (-not (Test-Path ".venv") -or -not (Test-Path $ConfigFile)) {
    Write-Host ""
    Write-Host "  +======================================+"
    Write-Host "  |       Glooow - First-time setup       |"
    Write-Host "  +======================================+"
    Write-Host ""

    # Ask about install mode
    Write-Host "  How would you like to run glooow?"
    Write-Host ""
    Write-Host "    App     - native window (default)"
    Write-Host "    Browser - lightweight, opens in your browser"
    Write-Host ""
    $InstallMode = Read-Host "  Press Enter for app, or B for browser-only"
    if ($InstallMode -eq "b" -or $InstallMode -eq "B") {
        $RequirementsFile = "requirements-browser.txt"
        Info "Installing in browser-only mode (lighter dependencies)"
    } else {
        Info "Installing full app with native window"
    }
    Write-Host ""
    # Windows doesn't need system dep install (PyAudio wheels are prebuilt)
    Ensure-Venv
    Ensure-Config
    Write-Host ""
    Ok "Setup complete! You can configure your LLM provider and"
    Ok "other settings in the web interface once it opens."
    Write-Host ""
} else {
    # Not first run - just check if deps need refreshing
    Ensure-Venv
}

# ── Read config values ───────────────────────────

$ConfigContent = Get-Content $ConfigFile -Raw
$LlmProvider = if ($ConfigContent -match '(?m)^\s*provider:\s*(.+?)(\s*#.*)?$') { $Matches[1].Trim() } else { "" }
$LlmModel    = if ($ConfigContent -match '(?m)^\s*model:\s*(.+?)(\s*#.*)?$')    { $Matches[1].Trim() } else { "" }
$ProxyUrl    = if ($ConfigContent -match '(?m)^\s*proxy_url:\s*(.+?)(\s*#.*)?$') { $Matches[1].Trim() } else { "" }
$OllamaUrl   = if ($ConfigContent -match '(?m)^\s*ollama_url:\s*(.+?)(\s*#.*)?$') { $Matches[1].Trim() } else { "http://localhost:11434" }

# For TTS engine, skip the first 'engine:' (which is under stt) and get the second
$TtsEngine = "browser"
$EngineMatches = [regex]::Matches($ConfigContent, '(?m)^\s*engine:\s*(.+?)(\s*#.*)?$')
if ($EngineMatches.Count -ge 2) {
    $TtsEngine = $EngineMatches[1].Groups[1].Value.Trim()
}

# ── Cleanup on exit ─────────────────────────────

$CleanupBlock = {
    Write-Host ""
    Info "Shutting down..."
    if ($ProxyProcess -and -not $ProxyProcess.HasExited) {
        Info "Stopping CLIProxyAPI (pid $($ProxyProcess.Id))..."
        Stop-Process -Id $ProxyProcess.Id -Force -ErrorAction SilentlyContinue
        Ok "CLIProxyAPI stopped"
    }
    Ok "Done."
}

try {
    # ── Startup banner ───────────────────────────────

    Write-Host ""
    Write-Host "  +======================================+"
    Write-Host "  |       Glooow                         |"
    Write-Host "  +======================================+"
    Write-Host ""
    Info "LLM:    $LlmProvider ($LlmModel)"
    Info "TTS:    $TtsEngine"
    Info "Config: $ConfigFile"
    Write-Host ""

    # ── Auto-start CLIProxyAPI if needed ─────────────

    if ($LlmProvider -eq "claude_proxy") {
        # Extract port from proxy_url
        $ProxyPort = "8317"
        if ($ProxyUrl -match ':(\d+)$') {
            $ProxyPort = $Matches[1]
        }

        $ProxyRunning = $false
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:${ProxyPort}/v1/models" -TimeoutSec 2
            $ProxyRunning = $true
        } catch {}

        if ($ProxyRunning) {
            Ok "CLIProxyAPI already running on port $ProxyPort"
        } else {
            if (Get-Command CLIProxyAPI -ErrorAction SilentlyContinue) {
                Info "Starting CLIProxyAPI on port $ProxyPort..."
                $ProxyProcess = Start-Process CLIProxyAPI -PassThru -WindowStyle Hidden

                # Wait for it to be ready (up to 10 seconds)
                $Ready = $false
                for ($i = 1; $i -le 20; $i++) {
                    try {
                        $null = Invoke-RestMethod -Uri "http://127.0.0.1:${ProxyPort}/v1/models" -TimeoutSec 1
                        Ok "CLIProxyAPI ready (pid $($ProxyProcess.Id))"
                        $Ready = $true
                        break
                    } catch {}
                    Start-Sleep -Milliseconds 500
                }
                if (-not $Ready) {
                    Warn "CLIProxyAPI didn't respond in 10s - it may still be loading"
                }
            }
        }
    }

    # ── Auto-start Ollama if needed ──────────────────

    if ($LlmProvider -eq "ollama") {
        $OllamaRunning = $false
        try {
            $null = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec 2
            $OllamaRunning = $true
        } catch {}

        if ($OllamaRunning) {
            Ok "Ollama running"
        } else {
            if (Get-Command ollama -ErrorAction SilentlyContinue) {
                Info "Starting Ollama..."
                Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
                $Ready = $false
                for ($i = 1; $i -le 20; $i++) {
                    try {
                        $null = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec 1
                        Ok "Ollama ready"
                        $Ready = $true
                        break
                    } catch {}
                    Start-Sleep -Milliseconds 500
                }
                if (-not $Ready) {
                    Warn "Ollama didn't respond in 10s - it may still be loading"
                }
            }
        }
    }

    # ── Launch the web app ───────────────────────────

    Info "Starting Glooow web server..."
    Write-Host ""

    if ($AutoOpen) { $env:GLOOOW_AUTO_OPEN = "1" }
    uv run python -m src.web

} finally {
    & $CleanupBlock
}

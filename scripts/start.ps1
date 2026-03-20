# ─────────────────────────────────────────────────
# Glooow — Launch script (Windows)
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

# ── Check uv ─────────────────────────────────────

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Err "uv not found. Run .\scripts\setup-local.ps1 first or install uv: https://docs.astral.sh/uv/"
}

# ── Read config values ───────────────────────────

if (-not (Test-Path $ConfigFile)) {
    Err "Config not found at $ConfigFile. Run .\scripts\setup-local.ps1 first."
}

# Extract key values from YAML (simple regex — avoids needing a YAML parser)
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

    if ($TtsEngine -eq "macos") {
        Write-Host ""
        Warn "macOS TTS engine is not available on Windows."
        Warn "Set tts.engine to 'browser' or 'piper' in $ConfigFile"
    }
    if ($TtsEngine -eq "browser") {
        Write-Host ""
        Write-Host "  Tip: for the best voice quality on Windows, open glooow in Edge."
        Write-Host "  Edge has access to Microsoft's natural voices (Ava, Jenny) which"
        Write-Host "  sound much better than the default system voices in Chrome/Firefox."
    }
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

# ─────────────────────────────────────────────────
# Glooow — Uninstaller (Windows)
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $ScriptDir)

$ConfigFile = "config\default.yaml"

function Info($msg)  { Write-Host "`n  > $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }

function AskYN($prompt, $default) {
    $answer = Read-Host "  $prompt [$default]"
    if (-not $answer) { $answer = $default }
    return ($answer -eq "Y" -or $answer -eq "y")
}

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |       Glooow - Uninstall             |"
Write-Host "  +======================================+"
Write-Host ""

# ── Remove Ollama models ────────────────────────

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    # Read model from config if it exists
    $OllamaModel = ""
    if (Test-Path $ConfigFile) {
        $match = Select-String -Path $ConfigFile -Pattern '^\s+ollama_model:\s*(.+)' | Select-Object -First 1
        if ($match) {
            $OllamaModel = $match.Matches[0].Groups[1].Value.Trim()
        }
    }

    # Check which glooow-related models are installed
    $InstalledModels = @()
    if ($OllamaModel) {
        $ModelBase = ($OllamaModel -split ":")[0]
        $listing = ollama list 2>$null
        if ($listing) {
            $InstalledModels = @($listing | Where-Object { $_ -match [regex]::Escape($ModelBase) } | ForEach-Object { ($_ -split '\s+')[0] })
        }
    }

    if ($InstalledModels.Count -gt 0) {
        Info "Found Ollama model(s) used by Glooow:"
        foreach ($m in $InstalledModels) {
            Write-Host "    $m"
        }
        Write-Host ""
        if (AskYN "Remove these models?" "Y") {
            foreach ($m in $InstalledModels) {
                ollama rm $m 2>$null
                Ok "Removed $m"
            }
        }
    }

    Write-Host ""
    if (AskYN "Uninstall Ollama itself?" "n") {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget uninstall Ollama.Ollama 2>$null
            Ok "Ollama uninstalled via winget"
        } else {
            Warn "Could not auto-uninstall Ollama. Remove it from Settings > Apps."
        }
        $OllamaData = "$HOME\.ollama"
        if (Test-Path $OllamaData) {
            if (AskYN "Remove Ollama data directory (~\.ollama)? This deletes ALL models" "n") {
                Remove-Item -Recurse -Force $OllamaData
                Ok "Removed $OllamaData"
            }
        }
    }
}

# ── Remove Whisper model cache ──────────────────

$WhisperCache = "$HOME\.cache\whisper"
if (Test-Path $WhisperCache) {
    Info "Found Whisper model cache at $WhisperCache"
    $CacheSize = "{0:N0} MB" -f ((Get-ChildItem -Recurse $WhisperCache | Measure-Object -Property Length -Sum).Sum / 1MB)
    Write-Host "    Size: $CacheSize"
    if (AskYN "Remove Whisper cache?" "Y") {
        Remove-Item -Recurse -Force $WhisperCache
        Ok "Removed Whisper cache"
    }
}

# ── Remove Python virtual environment ───────────

if (Test-Path ".venv") {
    Info "Removing Python virtual environment..."
    Remove-Item -Recurse -Force ".venv"
    Ok "Removed .venv"
}

# ── Remove config ───────────────────────────────

if (Test-Path $ConfigFile) {
    Info "Removing configuration..."
    Remove-Item -Force $ConfigFile
    Ok "Removed $ConfigFile"
}

# ── Remove saved sessions ───────────────────────

if (Test-Path "sessions") {
    $SessionCount = (Get-ChildItem -Recurse "sessions" -Filter "*.json" -ErrorAction SilentlyContinue).Count
    if ($SessionCount -gt 0) {
        Info "Found $SessionCount saved session(s) in sessions/"
        if (AskYN "Remove saved sessions?" "n") {
            Remove-Item -Recurse -Force "sessions"
            Ok "Removed sessions/"
        } else {
            Ok "Kept sessions/"
        }
    }
}

# ── Remove install breadcrumb ────────────────────

$Breadcrumb = "$HOME\.glooow-path"
if (Test-Path $Breadcrumb) {
    Remove-Item -Force $Breadcrumb
    Ok "Removed $Breadcrumb"
}

# ── Remove Desktop shortcut ─────────────────────

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Glooow.lnk"
if (Test-Path $ShortcutPath) {
    Info "Removing Desktop shortcut..."
    Remove-Item -Force $ShortcutPath
    Ok "Removed Desktop shortcut"
}

# ── Remove project directory ────────────────────

$ProjectDir = (Get-Location).Path
Write-Host ""
if (AskYN "Remove the Glooow project directory ($ProjectDir)?" "n") {
    Write-Host ""
    Warn "This will delete the entire project directory."
    if (AskYN "Are you sure?" "n") {
        Set-Location $HOME
        Remove-Item -Recurse -Force $ProjectDir
        Ok "Removed $ProjectDir"
        Write-Host ""
        Write-Host "  Glooow has been completely removed."
        Write-Host ""
        exit 0
    }
}

# ── Done ─────────────────────────────────────────

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |        Uninstall Complete!            |"
Write-Host "  +======================================+"
Write-Host ""
Write-Host "  Note: uv was left in place (shared tool)."
Write-Host ""

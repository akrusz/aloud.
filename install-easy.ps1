# ─────────────────────────────────────────────────
# Glooow — Easy installer (Windows)
# Usage: irm https://raw.githubusercontent.com/akrusz/glooow/main/install-easy.ps1 | iex
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$GlooowDir = if ($env:GLOOOW_DIR) { $env:GLOOOW_DIR } else { "$HOME\glooow" }
$RepoUrl = "https://github.com/akrusz/glooow.git"

function Info($msg)  { Write-Host "  > $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |       Glooow - Easy Install          |"
Write-Host "  +======================================+"
Write-Host ""

# ── Check git ────────────────────────────────────

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  X git not found. Install git from https://git-scm.com and re-run this script." -ForegroundColor Red
    exit 1
}

# ── Clone or update ──────────────────────────────

if (Test-Path $GlooowDir) {
    Info "glooow already exists at $GlooowDir"
    $answer = Read-Host "  Update with git pull? [Y/n]"
    if (-not $answer -or $answer -eq "Y" -or $answer -eq "y") {
        Set-Location $GlooowDir
        git pull
        Ok "Updated"
    }
} else {
    Info "Cloning glooow to $GlooowDir..."
    git clone $RepoUrl $GlooowDir
    Ok "Cloned"
}

Set-Location $GlooowDir

# ── Check uv ─────────────────────────────────────

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Info "uv not found. Installing uv..."
    irm https://astral.sh/uv/install.ps1 | iex
    # Refresh PATH
    $env:PATH = "$HOME\.local\bin;$HOME\.cargo\bin;$env:PATH"
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host "  X uv installation failed. Install manually: https://docs.astral.sh/uv/" -ForegroundColor Red
        exit 1
    }
    Ok "uv installed"
}

# ── Install dependencies ─────────────────────────

Info "Installing Python dependencies..."
uv venv --quiet --python ">=3.10" .venv 2>$null
uv pip install --quiet -r requirements.txt
Ok "Python dependencies installed"

Info "Pre-downloading Whisper model (small, ~500MB on first download)..."
uv run python -c "import whisper; whisper.load_model('small')"
Ok "Whisper model ready"

# ── Create config if missing ─────────────────────

if (-not (Test-Path "config\default.yaml")) {
    Info "No config found — run install.sh interactively for full setup,"
    Info "or start the server and configure via the web UI."
}

# ── Create Desktop shortcut ──────────────────────

Info "Creating Desktop shortcut..."
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Glooow.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = Join-Path $GlooowDir "Start.bat"
$Shortcut.WorkingDirectory = $GlooowDir
$Shortcut.Description = "Launch Glooow meditation facilitator"
$Shortcut.Save()
Ok "Desktop shortcut created"

# ── Done ─────────────────────────────────────────

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |          Install Complete!            |"
Write-Host "  +======================================+"
Write-Host ""
Write-Host "  To start:"
Write-Host "    - Double-click Glooow on your Desktop"
Write-Host "    - Or: cd $GlooowDir; .\start.ps1"
Write-Host ""

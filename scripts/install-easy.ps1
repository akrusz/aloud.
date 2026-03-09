# ─────────────────────────────────────────────────
# Glooow — Easy installer (Windows)
# Usage: irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/install-easy.ps1 | iex
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

# ── Run installer ─────────────────────────────────

Info "Running installer..."
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# ── Create Desktop shortcut ──────────────────────

Info "Creating Desktop shortcut..."
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Glooow.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = Join-Path $GlooowDir "Start-Windows.bat"
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
Write-Host "    - Or: cd $GlooowDir; .\scripts\start.ps1"
Write-Host ""

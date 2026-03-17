# ─────────────────────────────────────────────────
# Glooow — Setup (install / update / uninstall)
# Usage: irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.ps1 | iex
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$GlooowDir = if ($env:GLOOOW_DIR) { $env:GLOOOW_DIR } else { "$HOME\glooow" }
$RepoUrl = "https://github.com/akrusz/glooow.git"

function Info($msg)  { Write-Host "  > $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |    Glooow - Install / Uninstall      |"
Write-Host "  +======================================+"
Write-Host ""

# ── If already installed, offer choices ─────────

if (Test-Path $GlooowDir) {
    Write-Host "  Glooow is installed at $GlooowDir"
    Write-Host ""
    Write-Host "    1) Update       - pull latest changes and re-run setup"
    Write-Host "    2) Uninstall    - remove Glooow and downloaded models"
    Write-Host "    3) Cancel"
    Write-Host ""
    $Action = Read-Host "  Choice [1]"
    if (-not $Action) { $Action = "1" }

    if ($Action -eq "3") {
        Write-Host ""; exit 0
    } elseif ($Action -eq "2") {
        Set-Location $GlooowDir
        powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
        exit 0
    } else {
        Set-Location $GlooowDir
        Info "Updating..."
        git pull
        Ok "Updated"
        Info "Running setup..."
        powershell -ExecutionPolicy Bypass -File scripts\install.ps1
        exit 0
    }
}

# ── Fresh install ────────────────────────────────

# Check git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  X git not found. Install git from https://git-scm.com and re-run this script." -ForegroundColor Red
    exit 1
}

# Clone
Info "Cloning glooow to $GlooowDir..."
git clone $RepoUrl $GlooowDir
Ok "Cloned"

Set-Location $GlooowDir

# Run installer
Info "Running installer..."
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# Create Desktop shortcut
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

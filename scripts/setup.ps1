# ─────────────────────────────────────────────────
# Glooow — Setup (fresh setup / update / uninstall)
# Usage: irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.ps1 | iex
# ─────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$Breadcrumb = "$HOME\.glooow-path"
$RepoUrl = "https://github.com/akrusz/glooow.git"

# Resolve path: env var > breadcrumb > default
if ($env:GLOOOW_DIR) {
    $GlooowDir = $env:GLOOOW_DIR
} elseif (Test-Path $Breadcrumb) {
    $GlooowDir = (Get-Content $Breadcrumb -Raw).Trim()
} else {
    $GlooowDir = "$HOME\glooow"
}

function Info($msg)  { Write-Host "  > $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  +======================================+"
Write-Host "  |       Glooow - Setup                  |"
Write-Host "  +======================================+"
Write-Host ""

# ── If already set up, offer choices ─────────

if (Test-Path $GlooowDir) {
    Write-Host "  Glooow is set up at $GlooowDir"
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
        Info "Starting glooow..."
        powershell -ExecutionPolicy Bypass -File scripts\start.ps1 --open
        exit 0
    }
}

# ── Fresh setup ───────────────────────────────

# Check git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  X git not found. Install git from https://git-scm.com and re-run this script." -ForegroundColor Red
    exit 1
}

# Choose location
Write-Host "  Where would you like to set up Glooow?"
Write-Host ""
Write-Host "    1) $GlooowDir (default)"
Write-Host "    2) Current directory ($((Get-Location).Path)\glooow)"
Write-Host "    3) Custom path"
Write-Host ""
$LocChoice = Read-Host "  Choice [1]"
if (-not $LocChoice) { $LocChoice = "1" }

if ($LocChoice -eq "2") {
    $GlooowDir = Join-Path (Get-Location).Path "glooow"
} elseif ($LocChoice -eq "3") {
    $CustomPath = Read-Host "  Path"
    if (-not $CustomPath) {
        Write-Host "  X No path provided." -ForegroundColor Red
        exit 1
    }
    # Expand ~ to home directory
    if ($CustomPath.StartsWith("~")) {
        $CustomPath = $CustomPath -replace "^~", $HOME
    }
    $GlooowDir = $CustomPath
}

# Clone
Info "Cloning glooow to $GlooowDir..."
git clone $RepoUrl $GlooowDir
Ok "Cloned"

Set-Location $GlooowDir

# Save path so future runs can find it
$GlooowDir | Set-Content $Breadcrumb -Encoding UTF8

# Start (bootstraps on first run)
Info "Starting glooow..."
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 --open

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
Write-Host "  |          Setup Complete!              |"
Write-Host "  +======================================+"
Write-Host ""
Write-Host "  To start again later:"
Write-Host "    - Double-click Glooow on your Desktop"
Write-Host "    - Or: cd $GlooowDir; .\scripts\start.ps1"
Write-Host ""

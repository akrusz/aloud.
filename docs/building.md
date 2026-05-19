# Building aloud for Desktop

aloud uses PyInstaller to create standalone desktop apps. Each platform must be built on its own OS — PyInstaller doesn't cross-compile.

## Prerequisites (all platforms)

```bash
uv pip install pyinstaller
```

## macOS (.dmg)

Already automated. Requires `create-dmg`:

```bash
brew install create-dmg
scripts/build-dmg.sh
```

Output: `dist/aloud-{version}.dmg`

## Windows (.exe)

### Setup

You need a Windows machine (or VM/CI runner) with:

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Git (to clone the repo)

```powershell
git clone https://github.com/akrusz/glooow.git
cd aloud
uv pip install -r requirements.txt
uv pip install pyinstaller
```

### Icon

Convert the macOS icon to `.ico`. You can do this on any machine with ImageMagick:

```bash
# On your Mac (one-time, commit the result)
magick assets/aloud.icns assets/aloud.ico
```

Or use an online converter. Place the file at `assets/aloud.ico`.

### Spec changes

The `aloud.spec` file needs minor adjustments for Windows. The `BUNDLE(...)` block at the bottom is macOS-only. PyInstaller ignores it on Windows, but you'll also want to set the icon on the EXE:

```python
exe = EXE(
    ...
    icon='assets/aloud.ico',   # add this line
    console=False,              # already set — hides the terminal window
)
```

The `BUNDLE(...)` section is skipped automatically on non-macOS.

### Build

```powershell
uv run pyinstaller aloud.spec --noconfirm
```

Output: `dist/aloud/aloud.exe` (a folder with the exe + supporting files)

### Package

For a single-folder distribution, zip it up:

```powershell
$version = python -c "import re; print(re.search('__version__\s*=\s*\x22(.+?)\x22', (Get-Content src/__init__.py -Raw)).Groups[1].Value)"
Compress-Archive -Path dist\aloud -DestinationPath "dist\aloud-$version-win.zip"
```

For a proper installer, use [NSIS](https://nsis.sourceforge.io/) or [Inno Setup](https://jrsoftware.org/isinfo.php). A minimal Inno Setup script:

```iss
[Setup]
AppName=aloud
AppVersion={#Version}
DefaultDirName={autopf}\aloud
DefaultGroupName=aloud
OutputBaseFilename=aloud-{#Version}
Compression=lzma2
SolidCompression=yes

[Files]
Source: "dist\aloud\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\aloud"; Filename: "{app}\aloud.exe"
Name: "{autodesktop}\aloud"; Filename: "{app}\aloud.exe"
```

### Platform notes

- **TTS**: The `macos` engine won't work. Default config should be `browser` or `piper` on Windows. Users can also use `elevenlabs`.
- **pywebview**: Uses EdgeChromium (WebView2) on Windows. It's bundled with Windows 11 and most Windows 10 installs. If missing, pywebview falls back to MSHTML.
- **Microphone**: No special permissions needed on Windows — the OS prompts the user.

## Linux (.AppImage)

### Setup

Build on an Ubuntu/Debian machine (or CI runner like `ubuntu-latest`):

```bash
git clone https://github.com/akrusz/glooow.git
cd aloud
uv pip install -r requirements.txt
uv pip install pyinstaller
```

Linux dependencies for pywebview and audio:

```bash
# pywebview (GTK/WebKit backend)
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1

# Audio (PyAudio / PortAudio)
sudo apt install portaudio19-dev python3-pyaudio
```

### Icon

Convert to PNG if you don't already have one:

```bash
# On Mac (one-time, commit the result)
sips -s format png --resampleWidth 256 assets/aloud.icns --out assets/aloud.png
```

### Build

```bash
uv run pyinstaller aloud.spec --noconfirm
```

Output: `dist/aloud/` folder

### Package as AppImage

Install [appimagetool](https://github.com/AppImage/appimagetool):

```bash
wget -O appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x appimagetool
```

Create the AppDir structure:

```bash
VERSION=$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"(.+?)\"', open('src/__init__.py').read()).group(1))")

mkdir -p aloud.AppDir/usr/bin
cp -r dist/aloud/* aloud.AppDir/usr/bin/
cp assets/aloud.png aloud.AppDir/aloud.png

# Desktop entry
cat > aloud.AppDir/aloud.desktop << 'EOF'
[Desktop Entry]
Name=aloud
Exec=aloud
Icon=aloud
Type=Application
Categories=Utility;
EOF

# AppRun launcher
cat > aloud.AppDir/AppRun << 'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/aloud" "$@"
APPRUN
chmod +x aloud.AppDir/AppRun

# Build
./appimagetool aloud.AppDir "dist/aloud-${VERSION}.AppImage"
```

### Platform notes

- **TTS**: `macos` engine won't work. Use `browser`, `piper` (works great on Linux), or `elevenlabs`.
- **pywebview**: Uses GTK+WebKit. Needs the system packages listed above.
- **Microphone**: PulseAudio or PipeWire must be running (standard on modern distros).

## CI/CD (GitHub Actions)

To automate builds for all three platforms on each release:

```yaml
# .github/workflows/build.yml
name: Build Release
on:
  release:
    types: [created]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            artifact: "*.dmg"
          - os: windows-latest
            artifact: "*.zip"
          - os: ubuntu-latest
            artifact: "*.AppImage"

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install uv
        run: pip install uv

      - name: Install dependencies
        run: |
          uv pip install --system -r requirements.txt
          uv pip install --system pyinstaller

      - name: Install Linux deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y python3-gi python3-gi-cairo \
            gir1.2-gtk-3.0 gir1.2-webkit2-4.1 portaudio19-dev

      - name: Install macOS deps
        if: runner.os == 'macOS'
        run: brew install create-dmg

      - name: Build
        run: uv run pyinstaller aloud.spec --noconfirm

      # Platform-specific packaging steps here (DMG/zip/AppImage)
      # Then upload to the release with:
      # - uses: softprops/action-gh-release@v2
      #   with:
      #     files: dist/aloud-*
```

This is a starting point — you'll flesh out the packaging step for each OS (the scripts above). The key idea: each platform builds on its own runner, packages the result, and uploads it to the GitHub Release.

## Asset naming for auto-updates

The in-app update system matches assets by file extension:

| Platform | Expected filename |
|----------|-------------------|
| macOS    | `aloud-{version}.dmg` |
| Windows  | `aloud-{version}.exe` (or `.zip`) |
| Linux    | `aloud-{version}.AppImage` |

Attach these to a GitHub Release tagged `v{version}` and the app will detect and offer the update.

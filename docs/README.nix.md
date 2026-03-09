# Building glooow with Nix

This project can be built and run using Nix with flakes support.

## Prerequisites

- Nix package manager with flakes enabled
- On macOS or Linux

To enable flakes, add this to `~/.config/nix/nix.conf`:
```
experimental-features = nix-command flakes
```

## Quick Start

### Enter development shell

```bash
nix develop
```

This will:
- Install all Python dependencies
- Install system dependencies (portaudio, ffmpeg)
- Set up a virtual environment with additional packages
- Set PYTHONPATH appropriately

Once in the shell, you can run:
```bash
python -m src.web    # Start web interface
python -m src        # Start CLI mode
```

### Run directly

```bash
nix run
```

This builds the package and runs the web interface.

### Build the package

```bash
nix build
```

The built package will be in `./result/bin/`:
- `glooow-web` - Start the web interface
- `glooow-cli` - Start CLI mode

## Using with direnv

If you have [direnv](https://direnv.net/) installed:

```bash
direnv allow
```

This will automatically enter the Nix development environment when you cd into the project directory.

## Notes

- The flake uses Python 3.11 by default
- System dependencies (portaudio, ffmpeg) are automatically included
- Some Python packages not in nixpkgs (sounddevice, webrtcvad, simple-websocket) are installed via pip in the development shell
- Configuration files should be placed in `config/default.yaml` as usual
- Sessions are saved to `sessions/` directory

## Troubleshooting

### Audio issues on Linux

If you encounter audio device errors, you may need to ensure PulseAudio or PipeWire is running:
```bash
# Check audio system
pactl info  # for PulseAudio
pw-cli info  # for PipeWire
```

### Whisper model download

The first time you run the application, Whisper will download its model (~500MB). This happens automatically but may take a few minutes depending on your connection.

## Traditional Nix

For users without flakes:
```bash
nix-shell
```

This uses the `shell.nix` compatibility shim.

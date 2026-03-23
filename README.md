# glooow

your voice is an overpowered and underrated tool for meditation and inner work.

**glooow** is a meditation facilitator that listens and responds to your voice. it can be a partner for somatic exploration, parts work, and spaced noting. it runs as a native desktop app and uses an LLM to guide you, whisper.cpp for speech recognition, and your mic for voice input.

works on macOS, Linux, and Windows. bring your own LLM — claude subscription via CLIProxyAPI, anthropic API key, openai, openrouter for cheap non-claude models (deepseek, kimi), venice.ai for privacy, or run fully local with ollama.

![glooow screenshot](docs/glooow-screen.png)

## what it does

glooow has two modes: exploration and noting.

**exploration**: you optionally set an intention, pick a preset or build your own combo, and start talking. the facilitator listens, transcribes what you say with whisper, sends it to an LLM, and speaks the response back. it can hold silence when appropriate and gently check in if you've been quiet for a while.

instead of fixed styles, you mix and match **attention focuses** (body, emotions, parts work) with **vibes** (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, then you can adjust anything. there's a directiveness slider so you can dial in how much guidance you want.

**noting**: you specify what virtual participants you'd like, if any — AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1–2 words) or plays their fixed phrase or sound. if there are no other participants, it'll just briefly introduce the method and then record what you note.

## getting started

### macOS desktop app

download the DMG from [releases](https://github.com/akrusz/glooow/releases), drag Glooow to Applications, and double-click. that's it — no terminal, no Python install needed.

the app runs in a native window with a frameless design. all settings (LLM provider, voice, whisper model, display) are configurable from the settings page inside the app. whisper models download automatically on first launch.

### easy setup (macOS / Linux)

if you prefer running from source:

```bash
curl -fsSL https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.sh | bash
```

this clones the repo to `~/glooow`, installs everything, and puts a launcher on your Desktop. works on both macOS and Linux. run it again to update or uninstall.

### easy setup (Windows)

```powershell
irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.ps1 | iex
```

this clones the repo to `~\glooow`, installs dependencies, and puts a shortcut on your Desktop. run it again to update or uninstall.

### double-click launchers

if you already cloned the repo, you can skip the terminal entirely:

| file | what it does |
|------|--------------|
| **Setup-Mac.command** / **Setup-Windows.bat** / **Setup-Linux.desktop** | runs the setup wizard |
| **Start-Mac.command** / **Start-Windows.bat** / **Start-Linux.desktop** | starts the server and opens your browser |

### manual setup

you need:
- python 3.10+
- [uv](https://docs.astral.sh/uv/) for package management (the setup script will offer to install it if missing)
- a mic
- an LLM provider (see below)

then:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
./scripts/setup-local.sh        # walks you through setup — deps, LLM provider, whisper model
./scripts/start.sh              # starts the server (and CLIProxyAPI if needed)
```

on windows, use `.\scripts\start.ps1` instead of `./scripts/start.sh`. if you need to install uv: `irm https://astral.sh/uv/install.ps1 | iex`

### running the server

```bash
./scripts/start.sh           # full launcher: auto-starts CLIProxyAPI, shows config banner
./scripts/start-server.sh    # lightweight: just runs the server, nothing else
uv run python -m src.web     # direct, same as start-server.sh
uv run python -m src.web --browser  # open in browser instead of native window
```

once running, the server listens on port 4649 (よろしく):

| key | action |
|-----|--------|
| **B** or **Space** | open in browser |
| **Q** or **Ctrl+C** | quit |

### browser access

glooow also works in your browser. pass `--browser` to open it there instead of the native window, or just visit `http://localhost:4649` while the server is running. this is useful on Windows, Linux, or if you want to access it from another device on your LAN.

### platform notes

- **macOS**: the desktop app bundles everything. when running from source, TTS uses the `say` command with access to all system voices.
- **windows**: for best voice quality, use Edge — it has access to Microsoft's natural voices (Ava, Jenny) through speechSynthesis. Chrome and Firefox only have the basic system voices.
- **linux**: for server-side TTS, install piper-tts (`uv pip install piper-tts`) and set `tts.engine: piper`. otherwise TTS falls back to browser speechSynthesis.

### nix

if you have nix with flakes enabled:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
nix develop -c python -m src.web
```

the flake automatically sets up all dependencies including portaudio, ffmpeg, and python packages. the dev shell creates `config/default.yaml` if it doesn't exist.

## how it works

- **audio capture** — Web Audio API in the browser, shipped as raw PCM to the server
- **speech recognition** — whisper.cpp via pywhispercpp running locally (~39MB for the small model, no PyTorch needed)
- **LLM** — claude via CLIProxyAPI or anthropic API, openai, openrouter (deepseek, kimi, etc.), venice.ai, or local ollama
- **TTS** — macOS `say` command, browser speechSynthesis, piper-tts, or ElevenLabs for premium quality

## settings

all settings are configurable from the in-app settings page — LLM provider, whisper model, voice, pacing, facilitation style, and display options. changes save to `~/Library/Application Support/Glooow/config.yaml` (macOS) or the OS-equivalent config directory.

you can also edit `config/default.yaml` directly if running from source:

```yaml
tts:
  engine: macos      # macos, piper, browser, elevenlabs, parakeet
  voice: "Zoe (Premium)"
  rate: 160

llm:
  provider: claude_proxy   # claude_proxy, anthropic, openai, openrouter, venice, ollama
  model: claude-sonnet-4-6

facilitation:
  directiveness: 3       # 0-10 scale
  focuses: []            # body_sensations, emotions, inner_parts
  vibes: []              # playful, compassionate, loving, spacious, effortless, feeling_good
  verbosity: medium      # low, medium, high

stt:
  engine: whisper        # whisper (whisper.cpp, default), whisper-legacy (openai-whisper + torch)
  model: small           # tiny, base, small, medium, large

pacing:
  extended_silence_sec: 300   # seconds before check-in
  silence_base_ms: 3000       # pause before submitting speech
```

### LLM providers

the settings page shows which providers are configured. unavailable ones are marked with what you need to do.

**Anthropic (Subscription)** (default) — uses your claude subscription via CLIProxyAPI. install via homebrew, the setup script handles it. the desktop app can detect and start CLIProxyAPI for you from the new session page or settings.

**Anthropic (API Key)** — direct API access, no proxy needed
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**OpenAI (API Key)** — GPT-4, o3, etc. also works with any OpenAI-compatible endpoint via `llm.openai_base_url` in config.
```bash
export OPENAI_API_KEY=sk-...
```

**OpenRouter (API Key)** — deepseek, kimi, and other models at low cost
```bash
export OPENROUTER_API_KEY=sk-or-...
```

**Venice.ai (API Key)** — privacy-focused, no prompt storage
```bash
export VENICE_API_KEY=...
```

**Ollama (Local)** — fully local, no API key needed. the setup script can set this up automatically, or:
```bash
ollama pull qwen3.5:4b
```

## presets

quick-start presets pre-fill the focus/vibe checkboxes, then you can adjust anything:

| preset | what it does |
|---|---|
| **pleasant play** | playful exploration of pleasant sensations, natural absorption, jhana |
| **warmth & goodwill** | orienting toward warm feelings for yourself and others |
| **parts work** | explore inner parts, speak to them, let them speak back |
| **somatic** | body-focused — texture, temperature, movement, density |
| **freeform** | spacious, effortless. flow with whatever arises |
| **stillness** | minimal guidance, holding space for whatever wants to happen |

### dimensions

**attention focuses** — where to direct attention (0 or more, defaults to open awareness if none selected):
- body & sensations, emotions & feeling tone, parts & inner world

**vibes** — tone overlays (0 or more):
- playful & light, compassionate, loving & kind, spacious, effortless, feel-good

## tips

- the theme toggle in the top right follows your system preference by default, or just click it.
- if speech recognition feels slow, try the `base` whisper model (faster, less accurate).
- sessions auto-save to the sessions directory as JSON and plain text, with a short LLM-generated summary.
- from the history page you can continue any past session. the facilitator picks up where you left off with full context.
- say something like "hold on a bit" during a session to enter silence mode. say "come back" or similar to resume.
- say "mute" to immediately turn off the microphone. click the mic button to resume.
- the speaker button next to the mic toggles text-to-speech.
- set an intention loosely or not at all. the facilitator holds it lightly.
- click the orb in the nav bar to enter kasina gazing mode. click away from it to exit.
- the ember controls add floating particles. each level doubles the count and increases the size.
- click the voice name in the controls bar to open a voice picker — voices are grouped by quality tier with inline previews.

## building the desktop app

to build the macOS app and DMG installer from source:

```bash
scripts/generate-icon.sh           # generate .icns from favicon.svg
scripts/build-dmg.sh               # builds .app, signs it, creates DMG
```

requires `librsvg` and `create-dmg` (`brew install librsvg create-dmg`).

## project layout

```
src/
  web/              flask + socketio app, templates, vanilla JS frontend
  tts/              text-to-speech engines (macos, piper, parakeet, elevenlabs)
  stt/              whisper.cpp + legacy whisper speech-to-text
  llm/              LLM provider abstraction (claude, openai, openrouter, venice, ollama)
  facilitation/     prompt building, session management, pacing state machine
  audio/            CLI audio capture + VAD
  logging/          transcript logger
  frozen.py         PyInstaller bundle path resolution
  config.py         dataclass config with OS-native config directory
config/             default.yaml
scripts/
  setup-local.sh    setup / reconfigure / uninstall (interactive)
  setup.sh          one-line setup (macOS/linux)
  setup.ps1         one-line setup (windows)
  start.sh          full launcher (macOS/linux)
  start-server.sh   lightweight launcher
  start.ps1         full launcher (windows)
  generate-icon.sh  generate .icns from favicon.svg
  build-dmg.sh      build .app + DMG installer
assets/             app icon (.icns)
glooow.spec         PyInstaller build spec
docs/
  glooow-screen.png screenshot
```

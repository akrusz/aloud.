# glooow

your voice is an overpowered and underrated tool for meditation and inner work.

**glooow** is a meditation facilitator that listens and responds to your voice. it can be a partner for somatic exploration, parts work, and spaced noting. it uses an LLM to guide you, whisper.cpp for speech recognition, and your mic for voice input.

works on macOS, Linux, and Windows. bring your own LLM — claude subscription via CLIProxyAPI, anthropic API key, openai, openrouter for cheap non-claude models (deepseek, kimi), venice.ai for privacy, or run fully local with ollama.

![glooow screenshot](docs/glooow-screen.png)

## what it does

glooow has two modes: exploration and noting.

**exploration**: you optionally set an intention, pick a preset or build your own combo, and start talking. the facilitator listens, transcribes what you say with whisper, sends it to an LLM, and speaks the response back. it can hold silence when appropriate and gently check in if you've been quiet for a while.

instead of fixed styles, you mix and match **attention focuses** (body, emotions, parts work) with **vibes** (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, then you can adjust anything. there's a directiveness slider so you can dial in how much guidance you want.

in my personal experience, this sort of exploration has been useful in experiencing jhana states if approached with enough openheartedness.

**noting**: you specify what virtual participants you'd like, if any — AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1–2 words) or plays their fixed phrase or sound. if there are no other participants, it'll just briefly introduce the method and then record what you note.

## getting started

### download the app

grab the latest release for your platform from [releases](https://github.com/akrusz/glooow/releases):

| platform | download |
|----------|----------|
| **macOS** | `Glooow-x.x.x.dmg` — open the DMG, drag Glooow to Applications |
| **Windows** | `Glooow-x.x.x.exe` — run the installer |
| **Linux** | `Glooow-x.x.x.AppImage` — `chmod +x`, double-click or run from terminal |

no terminal, no Python install needed. all settings (LLM provider, voice, whisper model, display) are configurable from the settings page inside the app. whisper models download automatically on first launch. the app checks for updates on startup and will prompt you when a new version is available.

### platform notes

- **macOS**: TTS uses the `say` command with access to all system voices. the app runs in a native frameless window.
- **windows**: for best voice quality, use Edge — it has access to Microsoft's natural voices (Ava, Jenny) through speechSynthesis.
- **linux**: for server-side TTS, install piper-tts and set `tts.engine: piper` in settings. otherwise TTS falls back to browser speechSynthesis.

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

## running from source

for development or if you prefer not to use the app:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
uv pip install -r requirements.txt
uv run python -m src.web              # native window
uv run python -m src.web --browser    # open in browser instead
```

requires python 3.10+ and [uv](https://docs.astral.sh/uv/). once running, the server listens on port 4649 (よろしく). press **B** to open browser, **Q** to quit.

### setup scripts

the `scripts/` directory has helpers for getting set up and running from source:

| script | what it does |
|--------|--------------|
| `scripts/setup.sh` | one-line setup for macOS/Linux (clones repo, installs deps, creates Desktop launcher) |
| `scripts/setup.ps1` | one-line setup for Windows |
| `scripts/setup-local.sh` | interactive setup wizard (deps, LLM provider, whisper model) |
| `scripts/start.sh` | full launcher — auto-starts CLIProxyAPI, shows config banner |
| `scripts/start.ps1` | full launcher for Windows |
| `scripts/start-server.sh` | lightweight launcher — just runs the server |

there are also double-click launchers in `scripts/` (`Start-Mac.command`, `Start-Windows.bat`, `Start-Linux.desktop` and their Setup equivalents) if you want to skip the terminal entirely.

### nix

if you have nix with flakes enabled:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
nix develop -c python -m src.web
```

the flake automatically sets up all dependencies including portaudio, ffmpeg, and python packages. the dev shell creates `config/default.yaml` if it doesn't exist.

## building

release builds are automated via GitHub Actions — creating a release tagged `vX.X.X` triggers builds for all three platforms and attaches the artifacts. see [docs/building.md](docs/building.md) for manual build instructions.

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
scripts/            setup, launchers, build scripts
assets/             app icons
glooow.spec         PyInstaller build spec
docs/               screenshot, build guide
```

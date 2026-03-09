# glooow

your voice is an overpowered and underrated tool for meditation and inner work.

this is a meditation facilitator that listens and responds to your voice. it runs in your browser and uses an LLM to guide you, whisper for speech recognition, and your mic for voice input

works on macos, linux, and windows. bring your own LLM - claude subscription via CLIProxyAPI, anthropic API key, openrouter for cheap non-claude models (deepseek, kimi), venice.ai for privacy, or local ollama

![glooow screenshot](docs/glooow-screen.png)

## what it does

you start a session, optionally set an intention, pick a preset or build your own combo, and start talking. the facilitator listens, transcribes what you say with whisper, sends it to an LLM, and speaks the response back. it can hold silence when appropriate and gently check in if you've been quiet for a while

instead of fixed styles, you mix and match **attention focuses** (body, emotions, parts work) with **vibes** (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, then you can adjust anything. there's a directiveness slider so you can dial in how much guidance you want

## getting started

### easy install (macOS)

one line in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/akrusz/glooow/main/scripts/install-easy.sh | bash
```

this clones the repo to `~/glooow`, installs everything, and puts a Glooow app on your Desktop. double-click to launch

### easy install (windows)

one line in PowerShell:

```powershell
irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/install-easy.ps1 | iex
```

this clones the repo to `~\glooow`, installs dependencies, and puts a shortcut on your Desktop

### double-click launchers

if you already cloned the repo, you can skip the terminal entirely:

| file | what it does |
|------|--------------|
| **Install.command** (mac) / **Install.bat** (windows) | runs the installer |
| **Start.command** (mac) / **Start.bat** (windows) | starts the server and opens your browser |
| **Glooow.app** (mac only) | same as Start.command but works from anywhere |

### manual install

you need:
- python 3.10+
- [uv](https://docs.astral.sh/uv/) for package management (the install script will offer to install it if missing)
- a mic
- an LLM provider (see below)

then:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
./scripts/install.sh        # walks you through setup — deps, LLM provider, whisper model
./scripts/start.sh          # starts the server (and CLIProxyAPI if needed)
```

on windows, use `.\scripts\start.ps1` instead of `./scripts/start.sh`. if you need to install uv: `irm https://astral.sh/uv/install.ps1 | iex`

### running the server

```bash
./scripts/start.sh           # full launcher: auto-starts CLIProxyAPI, shows config banner
./scripts/start-server.sh    # lightweight: just runs the server, nothing else
uv run python -m src.web   # direct, same as start-server.sh
```

once running, the server listens on port 4649 (よろしく):

| key | action |
|-----|--------|
| **B** or **Space** | open in browser |
| **Q** or **Ctrl+C** | quit |

### platform notes

- **windows**: set `tts.engine: browser` in config. for best voice quality, use Edge — it has access to Microsoft's natural voices (Ava, Jenny) through speechSynthesis. Chrome and Firefox only get the basic system voices
- **linux**: for server-side TTS, install piper-tts (`uv pip install piper-tts`) and set `tts.engine: piper`. otherwise TTS falls back to browser speechSynthesis

### nix

if you have nix with flakes enabled:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
nix develop -c python -m src.web  # web server
nix develop -c python -m src      # CLI mode
```

the flake automatically sets up all dependencies including portaudio, ffmpeg, and python packages. the dev shell creates `config/default.yaml` if it doesn't exist

## how it works

- **audio capture** -- Web Audio API in the browser, shipped as raw PCM to the server
- **speech recognition** -- openai whisper running locally (the `small` model, ~500mb)
- **LLM** -- claude via CLIProxyAPI or anthropic API, openrouter (deepseek, kimi, etc.), venice.ai, or local ollama. also supports any OpenAI-compatible endpoint via config
- **TTS** -- macos `say` command on mac, browser speechSynthesis on linux/windows. piper-tts is an option if you want better quality server-side audio on linux

## presets

quick-start presets pre-fill the focus/quality checkboxes, then you can adjust anything:

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

## configuration

everything lives in `config/default.yaml`. the install script writes this for you but here's what you can tweak:

```yaml
tts:
  engine: macos      # macos, piper, browser, elevenlabs, parakeet
  voice: "Zoe (Premium)"
  rate: 120

llm:
  provider: claude_proxy   # claude_proxy, anthropic, openrouter, venice, ollama
  model: claude-sonnet-4-5-20250929

facilitation:
  directiveness: 3       # 0-10 scale
  focuses: []            # body_sensations, emotions, inner_parts
  vibes: []              # playful, compassionate, loving, spacious, effortless, feeling_good
  verbosity: medium      # low, medium, high

stt:
  model: small       # tiny, base, small, medium, large
```

### LLM providers

the web UI has a provider dropdown that shows which providers are configured. unavailable ones are marked with ✘ and show what you need to do

**CLIProxyAPI** (default) -- uses your claude subscription. install via homebrew, the install script handles it

**anthropic API** -- direct API access, no proxy needed
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
then select "Anthropic (API Key)" in the web UI, or set `llm.provider: anthropic` in config

**openrouter** -- access deepseek, kimi, and other models at low cost
```bash
export OPENROUTER_API_KEY=sk-or-...
```
then select "OpenRouter" in the web UI, or set `llm.provider: openrouter` in config. default model is DeepSeek V3.2

**venice.ai** -- privacy-focused, no prompt storage. good for meditation where you may not want conversations logged by the provider
```bash
export VENICE_API_KEY=...
```
then select "Venice.ai (Private)" in the web UI, or set `llm.provider: venice` in config

**openai-compatible** -- any OpenAI-compatible endpoint. set `OPENAI_API_KEY` and `llm.provider: openai` in config, with optional `llm.openai_base_url` for custom endpoints. not shown in the web UI dropdown but works via config

**ollama** -- fully local, no API key needed. the install script can set this up for you automatically (option 2), including installing ollama and downloading a default model (~2.5GB). or do it manually:
```bash
ollama pull qwen3.5:4b
```
select "Ollama (Local)" in the web UI — the model dropdown auto-populates with your pulled models. or set `llm.provider: ollama` in config

## cli mode

there's also a CLI version for hands-free sessions:

```bash
uv run python -m src
```

uses your mic directly via sounddevice and speaks responses through the system TTS. press ctrl-c to end

## tips

- the theme toggle in the top right follows your system preference by default, or just click it
- if speech recognition feels slow, try `stt.model: base` (faster, less accurate)
- on linux without piper, TTS falls back to browser speechSynthesis automatically
- sessions auto-save to `sessions/` as JSON and plain text, with a short LLM-generated summary
- from the history page you can continue any past session — the facilitator picks up where you left off with full context
- say something like "hold on a bit" during a session to enter silence mode. say anything to come back - it understands intent
- say "mute" to immediately turn off the microphone. click the mic button to resume
- set an intention loosely or not at all. the facilitator holds it lightly
- click the orb in the nav bar to enter kasina gazing mode. click away from it to exit
- click the voice name in the controls bar to open a voice picker modal — voices are grouped by quality tier and you can preview them before choosing

## project layout

```
src/
  web/              flask + socketio app, templates, JS
  tts/              text-to-speech engines (macos, piper, parakeet, elevenlabs)
  stt/              whisper speech-to-text
  llm/              LLM provider abstraction
  facilitation/     prompt building, session management
  audio/            CLI audio capture + VAD
config/             default.yaml
sessions/           saved transcripts
scripts/
  install.sh        first-time setup (interactive)
  install-easy.sh   one-line installer (macOS/linux)
  install-easy.ps1  one-line installer (windows)
  install.ps1       first-time setup (windows)
  start.sh          full launcher (macOS/linux) — auto-starts proxy, shows config
  start-server.sh   lightweight launcher — just the web server
  start.ps1         full launcher (windows)
docs/
  glooow-screen.png screenshot
  README.nix.md     nix-specific notes
Install.command     double-click installer (macOS)
Start.command       double-click launcher (macOS)
Install.bat         double-click installer (windows)
Start.bat           double-click launcher (windows)
Glooow.app/         macOS app bundle
```

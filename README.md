# glooow

your voice is an overpowered and underrated tool for meditation and inner work.

**glooow** is a meditation facilitator that listens and responds to your voice. it can be a partner for somatic exploration, parts work, and spaced noting as well. it runs in your browser and uses an LLM to guide you, whisper for speech recognition, and your mic for voice input.

works on macos, linux, and windows. bring your own LLM - claude subscription via CLIProxyAPI, anthropic API key, openai, openrouter for cheap non-claude models (deepseek, kimi), venice.ai for privacy, or it can install one for you with local ollama.

![glooow screenshot](docs/glooow-screen.png)

## what it does
glooow has two modes: exploration and noting.

**exploration**: you optionally set an intention, pick a preset or build your own combo, and start talking. the facilitator listens, transcribes what you say with whisper, sends it to an LLM, and speaks the response back. it can hold silence when appropriate and gently check in if you've been quiet for a while.

instead of fixed styles, you mix and match **attention focuses** (body, emotions, parts work) with **vibes** (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, then you can adjust anything. there's a directiveness slider so you can dial in how much guidance you want.

**noting**: you specify what virtual participants you'd like, if any - AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1-2 words) or plays their fixed phrase or sound. if there are no other participants, it'll just briefly introduce the method and then record what you note.

## getting started

### easy setup (macOS / Linux)

open Terminal, paste this line, and hit Return:

```bash
curl -fsSL https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.sh | bash
```

this clones the repo to `~/glooow`, installs everything, and puts a launcher on your Desktop. works on both macOS and Linux. run it again to update or uninstall.

### easy setup (Windows)

open PowerShell, paste this line, and hit Enter:

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
| **Glooow.app** (mac only) | same as Start-Mac.command but works from anywhere |

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

- **windows**: for best voice quality, use Edge — it has access to Microsoft's natural voices (Ava, Jenny) through speechSynthesis. Chrome and Firefox only have the basic system voices.
- **linux**: for server-side TTS, install piper-tts (`uv pip install piper-tts`) and set `tts.engine: piper`. otherwise TTS falls back to browser speechSynthesis.

### nix

if you have nix with flakes enabled:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
nix develop -c python -m src.web  # web server
nix develop -c python -m src      # CLI mode
```

the flake automatically sets up all dependencies including portaudio, ffmpeg, and python packages. the dev shell creates `config/default.yaml` if it doesn't exist.

## how it works

- **audio capture** -- Web Audio API in the browser, shipped as raw PCM to the server
- **speech recognition** -- openai whisper running locally (the `small` model, ~500mb)
- **LLM** -- claude via CLIProxyAPI or anthropic API, openai, openrouter (deepseek, kimi, etc.), venice.ai, or local ollama
- **TTS** -- macos `say` command on mac, browser speechSynthesis on linux/windows. piper-tts is an option if you want better quality server-side audio on linux.

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

everything lives in `config/default.yaml`. the setup script writes this for you but here's what you can tweak:

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
  model: small       # tiny, base, small, medium, large
```

### LLM providers

the web UI has a provider dropdown that shows which providers are configured. unavailable ones are marked with ✘ and show what you need to do.

**Anthropic (Subscription)** (default) -- uses your claude subscription via CLIProxyAPI. install via homebrew, the setup script handles it.

**Anthropic (API Key)** -- direct API access, no proxy needed
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
select "Anthropic (API Key)" in the web UI, or set `llm.provider: anthropic` in config

**OpenAI (API Key)** -- use GPT-4, o3, etc. also works with any OpenAI-compatible endpoint via `llm.openai_base_url` in config.
```bash
export OPENAI_API_KEY=sk-...
```
select "OpenAI (API Key)" in the web UI, or set `llm.provider: openai` in config

**OpenRouter (API Key)** -- access deepseek, kimi, and other models at low cost
```bash
export OPENROUTER_API_KEY=sk-or-...
```
select "OpenRouter (API Key)" in the web UI, or set `llm.provider: openrouter` in config

**Venice.ai (API Key)** -- privacy-focused, no prompt storage. good for meditation where you may not want conversations logged by the provider.
```bash
export VENICE_API_KEY=...
```
select "Venice.ai (API Key)" in the web UI, or set `llm.provider: venice` in config

**Ollama (Local)** -- fully local, no API key needed. the setup script can set this up for you automatically (option 2), including installing ollama and downloading a default model (~2.5GB). or do it manually:
```bash
ollama pull qwen3.5:4b
```
select "Ollama (Local)" in the web UI — the model dropdown auto-populates with your pulled models. or set `llm.provider: ollama` in config.

## cli mode

there's also a CLI version for hands-free sessions:

```bash
uv run python -m src
```

uses your mic directly via sounddevice and speaks responses through the system TTS. press ctrl-c to end.

## tips

- the theme toggle in the top right follows your system preference by default, or just click it.
- if speech recognition feels slow, try `stt.model: base` (faster, less accurate).
- on linux without piper, TTS falls back to browser speechSynthesis automatically.
- sessions auto-save to `sessions/` as JSON and plain text, with a short LLM-generated summary.
- from the history page you can continue any past session. the facilitator picks up where you left off with full context.
- say something like "hold on a bit" during a session to enter silence mode. say "come back" or similar to come back - it understands intent.
- say "mute" to immediately turn off the microphone. click the mic button to resume. both buttons show a line through them when off.
- the speaker button next to the mic toggles text-to-speech.
- set an intention loosely or not at all. the facilitator holds it lightly.
- click the orb in the nav bar to enter kasina gazing mode. click away from it to exit.
- the ember controls add floating particles. each level doubles the count and increases the size.
- click the voice name in the controls bar to open a voice picker modal — voices are grouped by quality tier and you can preview them before choosing.

## project layout

```
src/
  web/              flask + socketio app, templates, JS
  tts/              text-to-speech engines (macos, piper, parakeet, elevenlabs)
  stt/              whisper speech-to-text
  llm/              LLM provider abstraction
  facilitation/     prompt building, session management, noting prompts
  audio/            CLI audio capture + VAD
  logging/          transcript logger
config/             default.yaml
sessions/           saved transcripts
scripts/
  setup-local.sh    setup / reconfigure / uninstall (interactive)
  setup.sh          one-line setup: install, update, or uninstall (macOS/linux)
  setup.ps1         one-line setup: install, update, or uninstall (windows)
  uninstall.sh      standalone uninstaller (macOS/linux)
  uninstall.ps1     standalone uninstaller (windows)
  start.sh          full launcher (macOS/linux) — auto-starts proxy, shows config
  start-server.sh   lightweight launcher — just the web server
  start.ps1         full launcher (windows)
docs/
  glooow-screen.png screenshot
  README.nix.md     nix-specific notes
Setup-Mac.command         double-click setup wizard (macOS)
Start-Mac.command         double-click launcher (macOS)
Setup-Windows.bat         double-click setup wizard (Windows)
Start-Windows.bat         double-click launcher (Windows)
Setup-Linux.desktop       double-click setup wizard (Linux)
Start-Linux.desktop       double-click launcher (Linux)
Glooow.app/         macOS app bundle
```

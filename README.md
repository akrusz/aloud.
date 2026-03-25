# glooow

your voice is an overpowered and underrated tool for meditation and inner work.

**glooow** is a meditation facilitator that listens and responds to your voice. it can be a partner for somatic exploration, parts work, and spaced noting. it uses an LLM to guide you, whisper.cpp for speech recognition, and your mic for voice input.

works on macOS, Linux, and Windows. bring your own LLM — run fully local with ollama, use a claude subscription, or connect any API provider (anthropic, openai, openrouter, venice). all providers are configurable from the settings page.

![glooow screenshot](docs/glooow-screen.png)

## what it does

glooow has two modes: exploration and noting.

**exploration**: you optionally set an intention, pick a preset or build your own combo, and start talking. the facilitator listens, transcribes what you say with whisper, sends it to an LLM, and speaks the response back. it can hold silence when appropriate and gently check in if you've been quiet for a while.

instead of fixed styles, you mix and match **attention focuses** (body, emotions, parts work) with **vibes** (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, then you can adjust anything. there's a directiveness slider so you can dial in how much guidance you want.

in my personal experience, this sort of exploration has been helpful in experiencing jhana states if approached with enough openheartedness. thanks to [Maija Haavisto](https://lovingawakening.net/) and [Jhourney](https://www.jhourney.io/) for guiding me in similar practices.

**noting**: you specify what virtual participants you'd like, if any — AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1–2 words) or plays their fixed phrase or sound. if there are no other participants, it'll just briefly introduce the method and then record what you note. thanks to [Vince Horn](https://www.buddhistgeeks.org/) and again to [Jhourney](https://www.jhourney.io/) for inspiration.

## getting started

### download the app

grab the latest release for your platform from [releases](https://github.com/akrusz/glooow/releases):

| platform | download |
|----------|----------|
| **macOS** | `Glooow-x.x.x-macOS.dmg` — open the DMG, drag Glooow to Applications |
| **Windows** | `Glooow-x.x.x-Windows.exe` — run the installer |
| **Linux** | `Glooow-x.x.x-Linux.AppImage` — `chmod +x`, double-click or run from terminal |

no terminal, no Python install needed. all settings (LLM provider, voice, whisper model, display) are configurable from the settings page inside the app. whisper models download automatically on first launch. the app checks for updates on startup and will prompt you when a new version is available.

### platform notes

- **macOS**: TTS uses the `say` command with access to all system voices. the app runs in a native frameless window.
- **windows**: for best voice quality, use Edge — it has access to Microsoft's natural voices (Ava, Jenny) through speechSynthesis.
- **linux**: for server-side TTS, install piper-tts and set `tts.engine: piper` in settings. otherwise TTS falls back to browser speechSynthesis.

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
- sessions auto-save as JSON and plain text, with a short LLM-generated summary.
- from the history page you can continue any past session. the facilitator picks up where you left off with full context.
- say something like "hold on a bit" during a session to enter silence mode. say "come back" or similar to resume.
- say "mute" to immediately turn off the microphone. click the mic button to resume.
- the speaker button next to the mic toggles text-to-speech.
- set an intention loosely or not at all. the facilitator holds it lightly.
- click the orb in the nav bar to enter kasina gazing mode. click away from it to exit.
- the ember controls add floating particles. each level doubles the count and increases the size.
- click the voice name in the controls bar to open a voice picker — voices are grouped by quality tier with inline previews.

## running from source

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
./scripts/start.sh          # bootstraps on first run, then launches
```

on first run, `start.sh` installs dependencies, creates a Python environment, and writes a default config. configure your LLM provider and other settings in the web UI. requires python 3.10+ and [uv](https://docs.astral.sh/uv/) (installed automatically if missing).

there are also double-click launchers in `scripts/` (`Start-Mac.command`, `Start-Windows.bat`, `Start-Linux.desktop`).

### one-line install

```bash
# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/akrusz/glooow/main/scripts/setup.ps1 | iex
```

### nix

if you have nix with flakes enabled:

```bash
git clone https://github.com/akrusz/glooow.git
cd glooow
nix develop                             # browser-only (lighter): nix develop .#browser
./scripts/start.sh                      # auto-bootstraps config and launches
```

the flake provides portaudio, ffmpeg, python, uv, and GTK/WebKit2 (for pywebview) via the nix binary cache. python packages are installed via uv into a local venv on first entry.

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
config/             default.yaml
scripts/            launchers, build scripts
```

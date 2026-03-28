# Development Cheatsheet

Quick reference for running, debugging, and releasing glooow.

## Running

```bash
# Web server (default — native window via pywebview)
uv run python -m src.web

# Web server in browser (no pywebview window)
uv run python -m src.web --browser

# Custom host/port
uv run python -m src.web --host 0.0.0.0 --port 8080

# Debug logging (verbose output from src.* loggers)
uv run python -m src.web --debug

# CLI mode (headless, mic + system TTS)
uv run python -m src
```

## Debug & Testing Flags

These flags simulate different user states without touching your real config or data.

```bash
# Simulate a brand-new install (first-run welcome UI, clears localStorage)
uv run python -m src.web --fresh

# Hide Premium/Enhanced voices (triggers voice quality prompt)
uv run python -m src.web --hide-premium

# Return zero voices from /api/voices (triggers no-voices UI)
uv run python -m src.web --no-voices

# Piper voices show as "not downloaded" (test download flow UI)
uv run python -m src.web --reset-piper

# Combine flags — full fresh-install experience without premium voices
uv run python -m src.web --fresh --hide-premium

# Full fresh-install with no voices at all
uv run python -m src.web --fresh --no-voices

# Test the Piper onboarding: fresh install, no premium, download flow visible
uv run python -m src.web --fresh --hide-premium --reset-piper

# All flags work with --browser too
uv run python -m src.web --browser --fresh --hide-premium
```

| Flag | What it does |
|------|-------------|
| `--fresh` | Shows first-run settings UI, clears localStorage (voice prefs, embers, quality prompt) |
| `--hide-premium` | Filters out Premium/Enhanced voices from `/api/voices` so only basic voices appear |
| `--no-voices` | `/api/voices` returns `[]` — tests the empty-voices state |
| `--reset-piper` | Piper voices appear as not-yet-downloaded, download buttons re-enabled |
| `--debug` | Sets log level to DEBUG for all `src.*` loggers |
| `--browser` | Opens in system browser instead of pywebview native window |

## Session Management (CLI)

```bash
# List saved sessions
uv run python -m src --list-sessions

# View a session transcript
uv run python -m src --view-session SESSION_ID
```

## Tests

```bash
# All tests
uv run pytest tests/ -v

# Single file
uv run pytest tests/test_pacing.py -v

# Single test
uv run pytest tests/test_pacing.py::TestStateTransitions::test_initial_state_is_idle -v
```

## Releasing

```bash
# Bump patch (0.9.19 → 0.9.20) — default
scripts/release.sh

# Bump minor (0.9.19 → 0.10.0)
scripts/release.sh minor

# Bump major (0.9.19 → 1.0.0)
scripts/release.sh major

# Explicit version
scripts/release.sh 1.2.3

# Re-release current version (moves tag, recreates GitHub release)
scripts/release.sh same
```

The release script: bumps `src/__init__.py`, updates README download links, commits, tags, pushes, and creates a GitHub release (which triggers the build workflow).

**Prerequisites**: clean working directory, `gh` CLI authenticated.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `VENICE_API_KEY` | Venice API key |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS API key |
| `GLOOOW_SECRET_KEY` | Flask session secret |
| `GLOOOW_AUTO_OPEN` | Set to `1` to auto-open browser on startup |

## Config

User config: `~/.config/glooow/config.yaml` (macOS/Linux) — created on first save in settings.

Default config with all options: `config/default.yaml`

Supports `${ENV_VAR}` substitution for API keys in YAML.

## Building

See [docs/building.md](building.md) for desktop builds (PyInstaller → DMG/EXE/AppImage).

```bash
# macOS DMG (requires create-dmg, pyinstaller)
scripts/build-dmg.sh
```

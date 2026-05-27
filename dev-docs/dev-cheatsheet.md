# Development Cheatsheet

Quick reference for running, debugging, and releasing aloud.

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

# Piper hidden from engine list & recommendations
uv run python -m src.web --reset-piper

# All LLM providers appear unavailable (test cold-start provider setup)
uv run python -m src.web --no-providers

# Ollama appears not installed (test Ollama install/pull flow)
uv run python -m src.web --no-ollama

# Combine flags — full fresh-install experience without premium voices
uv run python -m src.web --fresh --hide-premium

# Full fresh-install with no voices at all
uv run python -m src.web --fresh --no-voices

# True cold-start: fresh install, no providers, no premium, no Piper
uv run python -m src.web --fresh --no-providers --hide-premium --reset-piper

# Test Ollama install flow with everything else available
uv run python -m src.web --fresh --no-ollama

# All flags work with --browser too
uv run python -m src.web --browser --fresh --hide-premium
```

| Flag | What it does |
|------|-------------|
| `--fresh` | Shows first-run settings UI, clears localStorage (voice prefs, embers, quality prompt) |
| `--hide-premium` | Filters out Premium/Enhanced voices from `/api/voices` so only basic voices appear |
| `--no-voices` | `/api/voices` returns `[]` — tests the empty-voices state |
| `--reset-piper` | Piper hidden from engine dropdown, voice quality modal, and hints |
| `--no-providers` | All LLM providers return `available: false` — tests zero-provider setup UI |
| `--no-ollama` | Ollama appears not installed/running — tests Ollama install flow |
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

The release script: offers to run the pre-release doc/copy check (`dev-docs/pre-release-checklist.md`, via the headless `claude` CLI), then bumps `src/__init__.py`, updates README download links, commits, tags, pushes, and creates a GitHub release (which triggers the build workflow). The macOS job in CI signs + notarizes automatically if the signing secrets are configured (see *Building* below); without them it produces an unsigned DMG.

**Prerequisites**: clean working directory, `gh` CLI authenticated.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `VENICE_API_KEY` | Venice API key |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS API key |
| `ALOUD_SECRET_KEY` | Flask session secret |
| `ALOUD_AUTO_OPEN` | Set to `1` to auto-open browser on startup |

## Config

User config: `~/.config/aloud/config.yaml` (macOS/Linux) — created on first save in settings.

Default config with all options: `config/default.yaml`

Supports `${ENV_VAR}` substitution for API keys in YAML.

## Building

See [building.md](building.md) for desktop builds (PyInstaller → DMG/EXE/AppImage).

```bash
# macOS DMG (requires create-dmg, pyinstaller)
scripts/build-dmg.sh

# Skip notarization (fast dev rebuild — DMG still signed, just not Apple-stamped)
SKIP_NOTARIZE=1 scripts/build-dmg.sh
```

### macOS signing + notarization (local)

The build script auto-detects a Developer ID cert in your keychain and the `notary` notarytool profile. One-time setup:

```bash
# 1. Developer ID Application cert installed in login keychain
#    (verify with: security find-identity -v -p codesigning | grep 'Developer ID')

# 2. Store notarytool credentials under the profile name "notary":
xcrun notarytool store-credentials "notary" \
  --apple-id YOUR_APPLE_ID_EMAIL \
  --team-id  YOUR_TEAM_ID \
  --password YOUR_APP_SPECIFIC_PASSWORD
```

Overrides via env vars: `CODESIGN_IDENTITY` (full cert name), `NOTARYTOOL_PROFILE` (defaults to `notary`), `SKIP_NOTARIZE=1`.

If neither a Developer ID cert nor the `notary` profile exists, the script falls back to an `aloud Dev` self-signed cert (or ad-hoc) and skips notarization — fine for local testing.

### macOS signing + notarization (CI)

`.github/workflows/build.yml` does the same dance from GitHub Secrets:

| Secret | Purpose |
|---|---|
| `MACOS_CERTIFICATE` | base64 of the Developer ID `.p12` |
| `MACOS_CERTIFICATE_PWD` | password set when exporting the `.p12` |
| `MACOS_KEYCHAIN_PWD` | any random string — unlocks the temp keychain on the runner |
| `MACOS_SIGN_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_TEAM_ID` | 10-char Team ID |
| `APPLE_APP_PASSWORD` | app-specific password from appleid.apple.com |

With those configured, `scripts/release.sh patch` produces a fully signed + notarized DMG with no manual steps.

## Landing site

Static site at `docs/` (hand-written, no build step). The folder is named `docs/` because GitHub Pages serves from `/docs` on main; internal developer documentation lives in `dev-docs/`. The download buttons fetch `releases/latest` from the GitHub API at page load, so the site doesn't need redeploying after each release.

```bash
# Local preview
python3 -m http.server -d docs 8000
# then open http://localhost:8000
```

Deployment: Porkbun's GitHub-pulled static hosting pointed at the `docs/` folder, or GitHub Pages from `/docs` on main.

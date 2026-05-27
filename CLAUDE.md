# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

aloud is a voice-based meditation facilitator. Users speak into a microphone, speech is transcribed via Whisper, an LLM generates facilitation responses, and TTS speaks them back. It has two interfaces: a web UI (Flask + SocketIO, primary) and a headless CLI.

## Commands

```bash
# Run the web server (port 4649)
uv run python -m src.web

# Run CLI mode (headless, uses mic + system TTS)
uv run python -m src

# Run tests
uv run pytest tests/ -v

# Run a single test file
uv run pytest tests/test_pacing.py -v

# Run a single test
uv run pytest tests/test_pacing.py::TestStateTransitions::test_initial_state_is_idle -v

# Install dependencies
uv pip install -r requirements.txt
```

## Architecture

### Dual entry points
- **Web**: `src/web/__main__.py` → `run_web()` in `src/web/app.py` — Flask + SocketIO server
- **CLI**: `src/__main__.py` → `main()` in `src/main.py` — headless audio loop

Both share the same backend modules for facilitation, LLM, STT, and TTS.

### Backend modules (`src/`)

| Module | Purpose |
|--------|---------|
| `facilitation/` | Core logic: `PacingController` (turn-taking state machine), `PromptBuilder` (composable system prompts), `SessionManager` (conversation history) |
| `llm/` | Protocol-based LLM providers: claude_proxy (subprocess to `claude` CLI for subscription routing), anthropic, openai, openrouter, venice, groq, ollama |
| `stt/whisper.py` | Whisper speech-to-text, loads model in background |
| `tts/` | Protocol-based TTS engines: macos, piper, elevenlabs; falls back to browser speechSynthesis |
| `audio/` | Audio I/O and `VoiceActivityDetector` (energy-based with adaptive noise floor) |
| `config.py` | Dataclass-based config loaded from `config/default.yaml` with `${ENV_VAR}` substitution |
| `log_config.py` | Structured logging for the `src` namespace |

### Web server (`src/web/`)

- `app.py` — `create_app()` factory
- `background.py` — background tasks (check-in loop, whisper loading, update check)
- `routes.py` — page routes (`/`, `/session`, `/history`, `/settings`, `sw.js`) + session/voice/TTS/window API endpoints; also registers the specialized route modules below
- `config_routes.py` — config GET/POST + config-folder routes
- `provider_routes.py` — provider/model endpoints (Ollama version/RAM/GPU checks, model-tier recommendation)
- `tool_routes.py` — tool-install endpoints (Ollama restart/upgrade)
- `socketio_handlers.py` — registers socket events (delegates to the handler modules below) + shared helpers (`get_session`, `speak_to_audio`)
- `session_handlers.py` — socket events: connect/disconnect, `start_session`, `end_session`, summary prefetch
- `message_handlers.py` — socket events: `user_message` (LLM response), resume-intent classification, noting labels
- `audio_handlers.py` — socket events: `audio_data` (Whisper transcription)
- `meditation_session.py` — `WebMeditationSession` wraps per-session state (LLM provider, prompts, pacing, session manager)
- `auth.py` — optional password authentication
- `cert.py` — self-signed certificate generation for LAN HTTPS

### Frontend (`src/web/static/js/`)

Vanilla JS with ES modules (`<script type="module">`), no build tools.

- `session.js` — orchestrator: imports modules, initializes, wires DOM events
- `audio.js` — mic capture, client-side VAD, speculative transcription, barge-in detection
- `state.js` — shared mutable state, DOM refs, socket instance
- `tts.js` — browser speechSynthesis + server WAV playback
- `voice.js` — voice picker modal and preview
- `socketHandlers.js` — all `socket.on()` handlers
- `ui.js` — message display, typing indicator, timer, embers, error toasts

A style guide exists in docs/style.md

### Key patterns

- **Protocol-based providers**: LLM and TTS use duck-typed protocols. Add new providers by implementing the interface and registering in the factory function.
- **Composable prompts**: `PromptBuilder` assembles system prompts from orthogonal dimensions — focuses (body, emotions, parts, open awareness), qualities (playful, compassionate, spacious, etc.), directiveness (0-10), and verbosity.
- **`[HOLD]` signal**: The LLM can prefix responses with `[HOLD]` to enter silence mode. `parse_hold_signal()` strips this prefix. Silence mode is exited when the user speaks again.
- **Pacing state machine**: IDLE → LISTENING → PROCESSING → RESPONDING → SILENT_HOLD. After `silence_checkin_sec` of silence the facilitator offers a gentle check-in (a canned phrase, not an LLM call); the timer resets after each, so check-ins recur at a fixed interval.
- **Background model loading**: Whisper loads asynchronously via `socketio.start_background_task()`. The `audio_data` handler guards with `app.whisper_model_ready`.
- **Context strategies**: SessionManager supports `full` (all history) or `rolling` (last N exchanges) context windows for the LLM.

### Data flow (web mode)

```
Browser mic → PCM audio → WebSocket "audio_data" → Whisper STT → transcription
→ "user_message" → SessionManager + PromptBuilder → LLM → parse [HOLD]
→ TTS (server WAV or browser) → "facilitator_message" → client playback
```

Background check-in loop runs every 10s, sends gentle prompts after extended silence.

## Configuration

All config is in `config/default.yaml` with dataclass defaults in `src/config.py`. Key env vars:
- `ALOUD_SECRET_KEY` — Flask secret key
- `ALOUD_AUTO_OPEN` — auto-open browser on startup
- API keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `VENICE_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`
- YAML supports `${ENV_VAR}` substitution for `llm.api_key` and `tts.api_key`

## Workflow notes

- **Use `uv`** for all Python commands (`uv run`, `uv pip`). Do not use `.venv/bin/python` directly.
- **No git push access** — Claude Code is not configured to push to GitHub. End sessions with `git commit` only; the user will push manually.
- **Pre-release check** — when asked to "run the pre-release check", or before cutting a release, work through `dev-docs/pre-release-checklist.md`: verify docs/copy still match the code and flag downstream consequences of recent changes.
- **Docs reference code by file + symbol, not line numbers** — line numbers rot on every edit; a `file.js` path plus a function/constant name stays greppable and durable. Don't write line numbers into docs.

## Issue tracking

This project uses **Beads** (`.beads/`). Use `bd create`, `bd list`, `bd update`, `bd close`, `bd sync` for issue management.

## Interacting with the developer

Feel free to be creative or playful when talking with the developer, and to take occasional breaks to write for fun. recess.md is another space you can use for this when running on his machine.

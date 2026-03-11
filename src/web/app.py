"""Flask web application for the meditation facilitator."""

import atexit
import asyncio
import os
import signal
import sys
import threading
import time
import webbrowser
from pathlib import Path

import httpx
import numpy as np
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit

from .. import __version__
from ..config import load_config, Config, PacingConfig
from ..llm.ollama import create_llm_provider
from ..updater import check_for_updates, apply_update
from ..llm.base import Message
from ..facilitation.pacing import PacingController, TurnDecision
from ..facilitation.prompts import PromptBuilder, PromptConfig, parse_hold_signal
from ..facilitation.session import SessionManager
from ..logging.transcript import TranscriptLogger
from ..stt.whisper import WhisperSTT
from ..tts import create_tts


class WebMeditationSession:
    """Manages a single meditation session via the web interface."""

    def __init__(
        self,
        config: Config,
        intention: str = "",
        focuses: list[str] | None = None,
        qualities: list[str] | None = None,
        directiveness: int = 3,
        verbosity: str = "low",
        custom_instructions: str = "",
        model: str | None = None,
        provider: str | None = None,
        tts_enabled: bool = True,
    ):
        self.config = config
        self.intention = intention
        self.tts_enabled = tts_enabled
        self.start_time = time.time()

        prompt_config = PromptConfig(
            focuses=focuses or [],
            qualities=qualities or [],
            directiveness=directiveness,
            verbosity=verbosity,
            custom_instructions=custom_instructions,
        )
        self.prompts = PromptBuilder(prompt_config)

        self.in_silence_mode = False

        self.pacing = PacingController(config.pacing)
        self.pacing.start_session()

        self.session = SessionManager(
            context_strategy=config.llm.context_strategy,
            window_size=config.llm.window_size,
        )

        # When the UI overrides the provider, don't pass config's api_key
        # so the provider falls back to its own env var.
        effective_provider = provider or config.llm.provider
        if provider and provider != config.llm.provider:
            api_key = None
        else:
            api_key = config.llm.api_key

        self.llm = create_llm_provider(
            provider=effective_provider,
            model=model or config.llm.model,
            proxy_url=config.llm.proxy_url,
            ollama_url=config.llm.ollama_url,
            api_key=api_key,
            max_tokens=config.llm.max_tokens,
            base_url=config.llm.openai_base_url,
        )

        self.session.start_session()

    def build_system_prompt(self) -> str:
        """Build system prompt, incorporating the meditator's intention."""
        base = self.prompts.build_system_prompt()
        if self.intention:
            base += (
                f"\n\nThe meditator's intention for this session: \"{self.intention}\"\n"
                "Hold this lightly. Follow their process rather than forcing toward the goal."
            )
        return base

    async def generate_response(self, user_text: str) -> tuple[str, str]:
        """Generate a facilitator response to user input.

        Returns:
            (response_text, hold_signal) — hold_signal is one of:
              "hold"    → activate silence mode
              "confirm" → AI is asking user to confirm before silence mode
              "none"    → normal response
        """
        self.session.add_user_message(user_text)

        messages = self.session.get_context_messages()
        llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]

        try:
            result = await self.llm.complete(
                messages=llm_messages,
                system=self.build_system_prompt(),
            )
            response = result.text.strip()
        except Exception as e:
            print(f"  [LLM ERROR] {type(e).__name__}: {e}", flush=True)
            response = "What do you notice now?"

        hold_signal, clean_response = parse_hold_signal(response)

        if hold_signal == "hold":
            self.in_silence_mode = True

        # Keep the [HOLD] prefix in conversation history so the LLM
        # knows it was in silence mode when interpreting later messages
        # like "come back" (which otherwise reads as a meditation cue).
        self.session.add_assistant_message(response if hold_signal == "hold" else clean_response)
        return clean_response, hold_signal

    def get_opener(self) -> str:
        """Get a static session opening message (fallback)."""
        opener = self.prompts.get_session_opener()
        self.session.add_assistant_message(opener)
        return opener

    async def generate_opener(self) -> str:
        """Generate an LLM-powered session opening.

        Uses the LLM to create a contextual welcome based on session settings,
        falling back to the static opener pool on error.
        """
        try:
            opener_prompt = self.prompts.build_opener_prompt(intention=self.intention)
            response, _ = await self.generate_response(opener_prompt)

            # Clean up: remove the fake user message (the opener prompt)
            # from conversation history. generate_response added both the
            # prompt as user and the response as assistant — keep only the
            # assistant response.
            if self.session.state and len(self.session.state.exchanges) >= 2:
                self.session.state.exchanges.pop(-2)

            return response
        except Exception as e:
            print(f"  [Opener] LLM opener failed ({e}), using static fallback", flush=True)
            return self.get_opener()

    async def generate_summary(self) -> str:
        """Generate a short summary of the session without modifying exchanges."""
        messages = self.session.get_context_messages()
        llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]
        llm_messages.append(Message(
            role="user",
            content=(
                "Summarize this meditation session in at most 10 words. "
                "Just the summary, nothing else."
            ),
        ))
        result = await self.llm.complete(
            messages=llm_messages,
            system=self.build_system_prompt(),
        )
        return result.text.strip()

    def end(self) -> dict | None:
        """End the session and return serialized data."""
        self.session.end_session()
        return self.session.to_dict()


def _migrate_style(style: str, directiveness: int = 3) -> dict:
    """Map a legacy style string to the new focuses/qualities params."""
    presets = {
        "pleasant_play": {
            "focuses": ["body_sensations", "emotions"],
            "qualities": ["playful", "feeling_good"],
            "directiveness": 3,
        },
        "compassion": {
            "focuses": ["emotions", "inner_parts"],
            "qualities": ["compassionate"],

            "directiveness": 3,
        },
        "somatic": {
            "focuses": ["body_sensations"],
            "qualities": [],

            "directiveness": 5,
        },
        "adaptive": {
            "focuses": [],
            "qualities": ["spacious", "effortless"],

            "directiveness": directiveness,
        },
        "non_directive": {
            "focuses": [],
            "qualities": [],

            "directiveness": 0,
        },
        "open": {
            "focuses": [],
            "qualities": ["spacious"],

            "directiveness": 0,
        },
    }
    return presets.get(style, presets["pleasant_play"])


def create_app(config: Config | None = None) -> tuple[Flask, SocketIO]:
    """Create and configure the Flask application."""
    if config is None:
        config = load_config()

    app = Flask(
        __name__,
        template_folder=str(Path(__file__).parent / "templates"),
        static_folder=str(Path(__file__).parent / "static"),
    )
    app.config["SECRET_KEY"] = "glooow-local"
    app.jinja_env.globals["glooow_version"] = __version__

    socketio = SocketIO(
        app,
        async_mode="threading",
        cors_allowed_origins="*",
        max_http_buffer_size=10 * 1024 * 1024,  # 10MB — ~2.5min of 16kHz float32 audio
    )

    app.meditation_config = config
    app.web_sessions = {}      # session_id → WebMeditationSession
    app.sid_to_session = {}    # socket sid → session_id
    app.session_to_sid = {}    # session_id → current socket sid
    app.transcript_logger = TranscriptLogger(
        save_directory=config.session.save_directory,
        include_timestamps=config.session.include_timestamps,
    )

    # Initialize server-side TTS for high-quality audio.
    # On platforms without a server-side engine (e.g. Linux without piper),
    # create_tts may raise — fall back to None and let the browser handle TTS.
    try:
        app.server_tts = create_tts(
            engine=config.tts.engine,
            voice=config.tts.voice,
            rate=config.tts.rate,
        )
    except Exception as e:
        print(f"  [TTS] Server-side TTS unavailable ({e}), using browser speechSynthesis", flush=True)
        app.server_tts = None

    # Initialize Whisper STT and pre-load model for fast first transcription
    app.whisper_stt = WhisperSTT(
        model=config.stt.model,
        language=config.stt.language,
        device=config.stt.device,
    )
    app.whisper_stt._load_model()
    app.whisper_lock = threading.Lock()

    _register_routes(app)
    _register_socketio_events(socketio, app)

    def _check_in_loop():
        """Background loop that checks for extended silence and sends check-ins."""
        while True:
            socketio.sleep(10)  # check every 10 seconds
            for session_id, web_session in list(app.web_sessions.items()):
                decision = web_session.pacing.should_respond()
                if decision == TurnDecision.CHECK_IN:
                    sid = app.session_to_sid.get(session_id)
                    if not sid:
                        continue
                    check_in = web_session.prompts.get_check_in_prompt()
                    web_session.session.add_assistant_message(check_in)
                    if web_session.in_silence_mode:
                        web_session.in_silence_mode = False
                        web_session.pacing.exit_silence_mode()
                        socketio.emit("silence_mode", {"active": False}, to=sid)
                    audio = None
                    if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
                        audio = app.server_tts.speak_to_bytes(check_in)
                    socketio.emit("facilitator_message", {
                        "text": check_in,
                        "type": "response",
                        "audio": audio,
                    }, to=sid)
                    web_session.pacing.on_response_end()

    socketio.start_background_task(_check_in_loop)

    def _startup_update_check():
        """Background startup check — log if update available."""
        try:
            status = check_for_updates()
            if status.available:
                print(f"  [Update] New version available ({status.commits_behind} commit(s) behind)", flush=True)
        except Exception:
            pass

    socketio.start_background_task(_startup_update_check)

    return app, socketio


def _register_routes(app: Flask) -> None:
    """Register HTTP routes."""

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/session")
    def session_page():
        return render_template("session.html")

    @app.route("/history")
    def history_page():
        sessions = app.transcript_logger.list_sessions()
        return render_template("history.html", sessions=sessions)

    @app.route("/api/providers")
    def api_providers():
        """Return provider availability based on env vars / proxy reachability."""
        results = {}

        # claude_proxy — check if CLIProxyAPI is reachable
        proxy_url = app.meditation_config.llm.proxy_url or "http://127.0.0.1:8317"
        try:
            headers = {}
            if app.meditation_config.llm.api_key:
                headers["X-Api-Key"] = app.meditation_config.llm.api_key
            resp = httpx.get(
                f"{proxy_url.rstrip('/')}/v1/models",
                headers=headers,
                timeout=2.0,
            )
            results["claude_proxy"] = {
                "available": resp.status_code == 200,
                "hint": "Start CLIProxyAPI, then reload this page" if resp.status_code != 200 else "",
            }
        except Exception:
            results["claude_proxy"] = {
                "available": False,
                "hint": "Start CLIProxyAPI, then reload this page",
            }

        # anthropic — needs ANTHROPIC_API_KEY
        results["anthropic"] = {
            "available": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "hint": "Set the ANTHROPIC_API_KEY environment variable",
        }

        # openai — needs OPENAI_API_KEY
        results["openai"] = {
            "available": bool(os.environ.get("OPENAI_API_KEY")),
            "hint": "Set the OPENAI_API_KEY environment variable",
        }

        # openrouter — needs OPENROUTER_API_KEY
        results["openrouter"] = {
            "available": bool(os.environ.get("OPENROUTER_API_KEY")),
            "hint": "Set the OPENROUTER_API_KEY environment variable",
        }

        # venice — needs VENICE_API_KEY
        results["venice"] = {
            "available": bool(os.environ.get("VENICE_API_KEY")),
            "hint": "Set the VENICE_API_KEY environment variable",
        }

        # ollama — check if server is running and list pulled models
        ollama_url = app.meditation_config.llm.ollama_url or "http://localhost:11434"
        try:
            resp = httpx.get(f"{ollama_url.rstrip('/')}/api/tags", timeout=2.0)
            resp.raise_for_status()
            models = [m["name"] for m in resp.json().get("models", [])]
            results["ollama"] = {
                "available": len(models) > 0,
                "models": models,
                "hint": "No models pulled. Run: ollama pull llama3" if not models else "",
            }
        except Exception:
            results["ollama"] = {
                "available": False,
                "models": [],
                "hint": "Ollama is not running. Install from ollama.ai and start it",
            }

        return jsonify(results)

    @app.route("/api/sessions")
    def api_sessions():
        sessions = app.transcript_logger.list_sessions()
        return jsonify(sessions)

    @app.route("/api/sessions/<session_id>")
    def api_session_detail(session_id):
        session = app.transcript_logger.load_session(session_id)
        if session is None:
            return jsonify({"error": "Session not found"}), 404
        return jsonify(session)

    @app.route("/api/sessions/<session_id>", methods=["DELETE"])
    def api_session_delete(session_id):
        deleted = app.transcript_logger.delete_session(session_id)
        return jsonify({"deleted": deleted})

    @app.route("/api/voices")
    def api_voices():
        """Return voices available to the server-side TTS engine."""
        if app.server_tts and hasattr(app.server_tts, "list_voices"):
            return jsonify(app.server_tts.list_voices())
        return jsonify([])

    @app.route("/api/voices/preview")
    def api_voice_preview():
        """Generate a short TTS preview for a given voice."""
        from flask import Response

        voice = request.args.get("voice")
        if not voice or not app.server_tts or not hasattr(app.server_tts, "speak_to_bytes"):
            return Response(status=404)

        text = request.args.get("text", "Welcome to glow. I'll be your guide.")

        # Temporarily switch voice, generate audio, then restore
        original_voice = app.server_tts.voice
        app.server_tts.set_voice(voice)
        try:
            audio = app.server_tts.speak_to_bytes(text)
        finally:
            app.server_tts.set_voice(original_voice)

        if not audio:
            return Response(status=500)
        return Response(audio, mimetype="audio/wav")

    @app.route("/api/update/check")
    def api_update_check():
        force = request.args.get("force", "0") == "1"
        status = check_for_updates(force=force)
        return jsonify({
            "available": status.available,
            "commits_behind": status.commits_behind,
            "commit_messages": status.commit_messages,
            "current_sha": status.current_sha,
            "remote_sha": status.remote_sha,
            "error": status.error,
            "is_git": status.is_git,
            "version": __version__,
        })

    @app.route("/api/update/apply", methods=["POST"])
    def api_update_apply():
        result = apply_update()
        return jsonify({
            "success": result.success,
            "message": result.message,
            "needs_restart": result.needs_restart,
        })

    @app.route("/api/models/<provider>")
    def api_models(provider):
        """Fetch available models from a provider's API."""
        models = _fetch_provider_models(provider, app.meditation_config)
        return jsonify(models)


# ---- Dynamic model fetching ----

_models_cache: dict[str, tuple[float, list]] = {}
_MODELS_CACHE_TTL = 300  # 5 minutes


def _fetch_provider_models(provider: str, config) -> list[dict]:
    """Fetch models from a provider API, with caching. Returns [{value, label}]."""
    now = time.time()
    cached = _models_cache.get(provider)
    if cached and now - cached[0] < _MODELS_CACHE_TTL:
        return cached[1]

    try:
        models = _do_fetch_models(provider, config)
    except Exception:
        return []

    if models:
        _models_cache[provider] = (now, models)
    return models


def _do_fetch_models(provider: str, config) -> list[dict]:
    """Provider-specific model fetching."""
    if provider == "openai":
        return _fetch_openai_models()
    elif provider == "anthropic":
        return _fetch_anthropic_models()
    elif provider == "claude_proxy":
        return _fetch_claude_proxy_models(config)
    elif provider == "openrouter":
        return _fetch_openrouter_models()
    elif provider == "venice":
        return _fetch_venice_models()
    # ollama is already dynamic in /api/providers
    return []


def _fetch_openai_models() -> list[dict]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])

    # Filter to chat models only
    chat_prefixes = ("gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt")
    exclude_terms = ("realtime", "audio", "search", "transcription",
                     "embedding", "moderation", "tts", "whisper", "dall-e",
                     "instruct")
    models = []
    for m in raw:
        mid = m["id"]
        if not any(mid.startswith(p) for p in chat_prefixes):
            continue
        if any(t in mid for t in exclude_terms):
            continue
        models.append({"value": mid, "label": _openai_label(mid), "created": m.get("created", 0)})

    # Sort newest first, deduplicate
    models.sort(key=lambda x: x["created"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models]


def _openai_label(model_id: str) -> str:
    """Turn an OpenAI model ID into a readable label."""
    # gpt-4.1-mini -> GPT-4.1 Mini, o3-mini -> o3 Mini
    parts = model_id.split("-")
    if parts[0].lower() == "gpt":
        parts[0] = "GPT"
    if parts[0].lower() == "chatgpt":
        parts[0] = "ChatGPT"
    return " ".join(
        p.capitalize() if p.isalpha() and p.lower() not in ("gpt", "chatgpt") else p
        for p in parts
    ).replace("GPT ", "GPT-").replace("ChatGPT ", "ChatGPT-")


def _fetch_anthropic_models() -> list[dict]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.anthropic.com/v1/models",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    models = []
    for m in raw:
        mid = m.get("id", "")
        label = m.get("display_name", mid)
        created = m.get("created_at", "")
        models.append({"value": mid, "label": label, "sort": created})

    models.sort(key=lambda x: x["sort"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models]


def _fetch_claude_proxy_models(config) -> list[dict]:
    proxy_url = config.llm.proxy_url or "http://127.0.0.1:8317"
    headers = {}
    if config.llm.api_key:
        headers["X-Api-Key"] = config.llm.api_key
    resp = httpx.get(
        f"{proxy_url.rstrip('/')}/v1/models",
        headers=headers,
        timeout=3,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    models = []
    for m in raw:
        mid = m.get("id", "")
        label = m.get("display_name", "") or mid
        created = m.get("created_at", m.get("created", ""))
        models.append({"value": mid, "label": label, "sort": created})

    models.sort(key=lambda x: x["sort"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models]


def _fetch_openrouter_models() -> list[dict]:
    # OpenRouter's models endpoint is public (no auth needed)
    resp = httpx.get("https://openrouter.ai/api/v1/models", timeout=8)
    resp.raise_for_status()
    raw = resp.json().get("data", [])

    # Filter to text generation models from well-known providers
    keep_orgs = {"anthropic", "openai", "google", "meta-llama",
                 "deepseek", "mistralai", "qwen", "moonshotai"}
    models = []
    for m in raw:
        mid = m.get("id", "")
        org = mid.split("/")[0] if "/" in mid else ""
        if org not in keep_orgs:
            continue
        # Skip free/extended variants
        if mid.endswith(":free") or mid.endswith(":extended"):
            continue
        label = m.get("name", mid)
        ctx = m.get("context_length", 0)
        models.append({"value": mid, "label": label, "ctx": ctx})

    # Sort by context length (proxy for recency/capability)
    models.sort(key=lambda x: x["ctx"], reverse=True)
    return [{"value": m["value"], "label": m["label"]} for m in models[:30]]


def _fetch_venice_models() -> list[dict]:
    api_key = os.environ.get("VENICE_API_KEY")
    if not api_key:
        return []
    resp = httpx.get(
        "https://api.venice.ai/api/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=5,
    )
    resp.raise_for_status()
    raw = resp.json().get("data", [])
    models = []
    for m in raw:
        mid = m.get("id", "")
        # Venice includes image/code models — filter to text
        mtype = m.get("type", "")
        if mtype and mtype not in ("text", "chat", ""):
            continue
        label = m.get("name", "") or mid
        models.append({"value": mid, "label": label})

    return models


def _register_socketio_events(socketio: SocketIO, app: Flask) -> None:
    """Register WebSocket event handlers."""

    def _get_session(sid):
        """Look up a WebMeditationSession by socket sid."""
        session_id = app.sid_to_session.get(sid)
        if session_id:
            return app.web_sessions.get(session_id)
        return None

    @socketio.on("connect")
    def handle_connect():
        pass

    @socketio.on("disconnect")
    def handle_disconnect():
        sid = request.sid
        # Only unmap the socket — keep the session alive so a reconnect
        # can pick it back up with full conversation history.
        app.sid_to_session.pop(sid, None)

    @socketio.on("start_session")
    def handle_start_session(data):
        sid = request.sid
        session_id = data.get("session_id")

        # Reconnection: session already exists, just re-map the new socket
        if session_id and session_id in app.web_sessions:
            app.sid_to_session[sid] = session_id
            app.session_to_sid[session_id] = sid
            print(f"  [Session] Reconnected sid={sid[:8]}… to session {session_id[:12]}…", flush=True)
            return

        config = app.meditation_config

        # Legacy migration: if old 'style' param received, map to presets
        if data.get("style") and not data.get("focuses"):
            migrated = _migrate_style(
                data["style"],
                data.get("directiveness", 3),
            )
            data.update(migrated)

        web_session = WebMeditationSession(
            config=config,
            intention=data.get("intention", ""),
            focuses=data.get("focuses", []),
            qualities=data.get("qualities", []),
            directiveness=data.get("directiveness", 3),
            verbosity=data.get("verbosity", "low"),
            custom_instructions=data.get("custom_instructions", ""),
            model=data.get("model"),
            provider=data.get("provider"),
            tts_enabled=data.get("tts", True),
        )

        if not session_id:
            session_id = sid  # fallback
        app.web_sessions[session_id] = web_session
        app.sid_to_session[sid] = session_id
        app.session_to_sid[session_id] = sid
        print(f"  [Session] New session {session_id[:12]}… for sid={sid[:8]}…", flush=True)

        # Handle continuation from a previous session
        continue_from = data.get("continue_from")
        if continue_from:
            old_session = app.transcript_logger.load_session(continue_from)
            if old_session and old_session.get("exchanges"):
                # Hydrate the new session with old exchanges for LLM context
                web_session.session.load_exchanges(old_session["exchanges"])
                # Store provenance
                web_session.continued_from = continue_from
                # Send old exchanges to the frontend for display
                emit("session_history", {"exchanges": old_session["exchanges"]})
                print(f"  [Session] Continuing from {continue_from[:12]}… ({len(old_session['exchanges'])} exchanges)", flush=True)

                # Generate a continuation opener via the LLM
                emit("facilitator_typing", {"typing": True})
                try:
                    continuation_note = (
                        "The meditator is returning to continue from a previous session. "
                        "Offer a brief, warm welcome back and gently acknowledge they're "
                        "picking up where they left off."
                    )
                    response, _ = asyncio.run(web_session.generate_response(continuation_note))
                    # Remove the internal note from history — replace with just the response
                    # The generate_response added both the note as user and response as assistant.
                    # We want to keep only the assistant response (remove the fake user message).
                    if web_session.session.state and len(web_session.session.state.exchanges) >= 2:
                        # Remove the continuation prompt (second-to-last) but keep the response (last)
                        web_session.session.state.exchanges.pop(-2)
                except Exception:
                    response = "Welcome back. Let's continue from where we left off."
                    web_session.session.add_assistant_message(response)

                audio = None
                if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
                    audio = app.server_tts.speak_to_bytes(response)
                emit("facilitator_message", {"text": response, "type": "opener", "audio": audio})
                web_session.pacing.on_response_end()
                return

        emit("facilitator_typing", {"typing": True})
        opener = asyncio.run(web_session.generate_opener())
        audio = None
        if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
            audio = app.server_tts.speak_to_bytes(opener)
        emit("facilitator_message", {"text": opener, "type": "opener", "audio": audio})
        web_session.pacing.on_response_end()

    @socketio.on("user_message")
    def handle_user_message(data):
        sid = request.sid
        web_session = _get_session(sid)
        if not web_session:
            emit("error", {"message": "No active session"})
            return

        text = data.get("text", "").strip()
        if not text:
            return

        # Any speech auto-exits silence mode
        was_silent = web_session.in_silence_mode
        if was_silent:
            web_session.in_silence_mode = False
            web_session.pacing.exit_silence_mode()
            emit("silence_mode", {"active": False})

        emit("facilitator_typing", {"typing": True})

        try:
            response, hold_signal = asyncio.run(web_session.generate_response(text))
            audio = None
            if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
                audio = app.server_tts.speak_to_bytes(response)
            emit("facilitator_message", {"text": response, "type": "response", "audio": audio})
            # Don't re-enter silence right after the user just exited it
            if hold_signal == "hold" and not was_silent:
                web_session.pacing.enter_silence_mode()
                emit("silence_mode", {"active": True})
            web_session.pacing.on_response_end()
        except Exception:
            emit("facilitator_message", {
                "text": "What do you notice now?",
                "type": "response",
            })
            web_session.pacing.on_response_end()
        finally:
            emit("facilitator_typing", {"typing": False})

    @socketio.on("prefetch_summary")
    def handle_prefetch_summary():
        """Pre-generate a session summary while the user is in a confirm dialog.

        Caches the result on the web_session so handle_end_session can skip
        the LLM call.
        """
        sid = request.sid
        web_session = _get_session(sid)
        if not web_session or hasattr(web_session, '_cached_summary'):
            return

        try:
            web_session._cached_summary = asyncio.run(web_session.generate_summary())
        except Exception:
            web_session._cached_summary = ""

    @socketio.on("end_session")
    def handle_end_session():
        sid = request.sid
        session_id = app.sid_to_session.pop(sid, None)
        if not session_id or session_id not in app.web_sessions:
            return

        app.session_to_sid.pop(session_id, None)
        web_session = app.web_sessions.pop(session_id)

        # Use pre-fetched summary if available, otherwise generate now
        if hasattr(web_session, '_cached_summary'):
            summary = web_session._cached_summary
        else:
            summary = ""
            try:
                summary = asyncio.run(web_session.generate_summary())
            except Exception:
                summary = ""

        session_data = web_session.end()
        if summary:
            session_data["summary"] = summary
        saved_id = None
        if session_data and app.meditation_config.session.auto_save:
            if hasattr(web_session, 'continued_from'):
                session_data["continued_from"] = web_session.continued_from
            app.transcript_logger.save_session(session_data)
            app.transcript_logger.save_session_text(session_data)
            saved_id = session_data.get("session_id")

        emit("session_ended", {
            "session_id": saved_id,
            "summary": summary,
        })

    @socketio.on("set_tts_rate")
    def handle_set_tts_rate(data):
        rate = data.get("rate")
        if rate and isinstance(rate, (int, float)) and app.server_tts:
            rate = max(80, min(180, int(rate)))
            app.server_tts.set_rate(rate)

    @socketio.on("set_tts_voice")
    def handle_set_tts_voice(data):
        voice = data.get("voice")
        if voice and app.server_tts:
            app.server_tts.set_voice(voice)

    @socketio.on("audio_data")
    def handle_audio_data(data):
        """Receive raw PCM float32 audio and transcribe with Whisper.

        Runs transcription in a background task so the event handler
        returns immediately — this keeps the socket alive during slow
        Whisper inference.
        """
        try:
            audio_bytes = data.get("audio")
            sample_rate = data.get("sample_rate", 16000)
            command_only = data.get("command_only", False)
            speculative_gen = data.get("speculative_gen")  # None for normal, int for speculative
            audio = np.frombuffer(audio_bytes, dtype=np.float32)
            duration = len(audio) / sample_rate
            label = " (command candidate)" if command_only else ""
            if speculative_gen is not None:
                label = f" (speculative gen {speculative_gen})"
            print(f"  [STT] Received {len(audio)} samples @ {sample_rate}Hz ({duration:.1f}s){label}", flush=True)
        except Exception as e:
            print(f"  [STT] Error parsing audio: {e}", flush=True)
            emit("transcription", {"text": "", "error": str(e)})
            return

        # Look up session so we can emit to the right socket even after
        # a reconnection changes the sid.
        session_id = app.sid_to_session.get(request.sid)

        def _transcribe():
            try:
                if not app.whisper_lock.acquire(timeout=15):
                    print("  [STT] Whisper busy, dropping audio", flush=True)
                    target_sid = app.session_to_sid.get(session_id)
                    if target_sid:
                        socketio.emit("transcription", {"text": "", "error": "busy"}, to=target_sid)
                    return

                try:
                    t0 = time.time()
                    result = app.whisper_stt.transcribe(audio, sample_rate=sample_rate)
                    elapsed = time.time() - t0
                    text = result.text.strip()
                    print(f"  [STT] Transcribed in {elapsed:.1f}s: \"{text}\"", flush=True)
                finally:
                    app.whisper_lock.release()

                # Emit to whatever socket is currently mapped to this session
                # (may have changed due to reconnection during transcription).
                target_sid = app.session_to_sid.get(session_id)
                if target_sid:
                    resp = {"text": text, "command_only": command_only}
                    if speculative_gen is not None:
                        resp["speculative_gen"] = speculative_gen
                    socketio.emit("transcription", resp, to=target_sid)
                else:
                    print("  [STT] No active socket for session, dropping result", flush=True)
            except Exception as e:
                print(f"  [STT] Error: {e}", flush=True)
                target_sid = app.session_to_sid.get(session_id)
                if target_sid:
                    socketio.emit("transcription", {"text": "", "error": str(e)}, to=target_sid)

        socketio.start_background_task(_transcribe)


def run_web(
    config_path: str | None = None,
    host: str = "0.0.0.0",
    port: int = 4649,  # よろしく
    debug: bool = False,
) -> None:
    """Run the web application."""
    config = load_config(config_path)

    # Check if LLM proxy is reachable when using claude_proxy provider
    if config.llm.provider == "claude_proxy":
        proxy_url = config.llm.proxy_url or "http://127.0.0.1:8317"
        headers = {}
        if config.llm.api_key:
            headers["X-Api-Key"] = config.llm.api_key
        try:
            resp = httpx.get(
                f"{proxy_url.rstrip('/')}/v1/models",
                headers=headers,
                timeout=3.0,
            )
            if resp.status_code == 401:
                print(f"\n  *** CLIProxyAPI at {proxy_url} rejected our API key ***")
                print(f"  Check api-keys in ~/.cli-proxy-api/config.yaml")
                print(f"  and llm.api_key in config/default.yaml\n")
                return
        except (httpx.ConnectError, httpx.TimeoutException):
            print(f"\n  *** CLIProxyAPI is not running at {proxy_url} ***")
            print(f"  Start it with: CLIProxyAPI")
            print(f"  Then restart this server.\n")
            return

    print(f"\n{'=' * 50}")
    print(f"  Glooow v{__version__} — starting up...")
    print(f"{'=' * 50}")

    app, socketio = create_app(config)

    url = f"http://localhost:{port}"
    print(f"\n  Ready: {url}")
    print(f"  B = open browser · Q = quit\n")

    if os.environ.get("GLOOOW_AUTO_OPEN") == "1":
        def _auto_open_browser():
            for _ in range(30):
                try:
                    httpx.get(url, timeout=1)
                    print(f"  Opening {url} ...", flush=True)
                    webbrowser.open(url)
                    return
                except Exception:
                    time.sleep(0.5)
        threading.Thread(target=_auto_open_browser, daemon=True).start()

    # Background thread: keyboard shortcuts while server runs
    _saved_termios = [None]

    def _restore_terminal():
        if _saved_termios[0] is not None:
            fd, old = _saved_termios[0]
            try:
                import termios as _t
                _t.tcsetattr(fd, _t.TCSADRAIN, old)
            except Exception:
                pass

    def _shutdown(*_):
        _restore_terminal()
        print("\n  Shutting down...", flush=True)
        sys.exit(0)

    if sys.stdin.isatty():
        atexit.register(_restore_terminal)

        def _keyboard_listener():
            try:
                if sys.platform == "win32":
                    import msvcrt
                    while True:
                        ch = msvcrt.getch()
                        if ch in (b"b", b"B", b" "):
                            print(f"  Opening {url} ...", flush=True)
                            webbrowser.open(url)
                        elif ch in (b"q", b"Q"):
                            _shutdown()
                else:
                    import tty, termios
                    fd = sys.stdin.fileno()
                    old = termios.tcgetattr(fd)
                    _saved_termios[0] = (fd, old)
                    tty.setcbreak(fd)
                    while True:
                        ch = os.read(fd, 1)
                        if ch in (b"b", b"B", b" "):
                            print(f"  Opening {url} ...", flush=True)
                            webbrowser.open(url)
                        elif ch in (b"q", b"Q"):
                            _shutdown()
            except (OSError, ValueError, ImportError):
                pass

        threading.Thread(target=_keyboard_listener, daemon=True).start()

    # Ensure Ctrl+C actually exits — threading mode can swallow KeyboardInterrupt
    signal.signal(signal.SIGINT, _shutdown)

    socketio.run(app, host=host, port=port, debug=debug, allow_unsafe_werkzeug=True)

"""HTTP route handlers for the Flask web application."""

import math
import os
import time

import httpx
from flask import Flask, render_template, request, jsonify, Response

from .. import __version__
from ..updater import check_for_updates, apply_update


def register_routes(app: Flask) -> None:
    """Register all HTTP routes on the Flask app."""

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/session")
    def session_page():
        return render_template("session.html")

    @app.route("/history")
    def history_page():
        return render_template("history.html")

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
        page = request.args.get("page", 1, type=int)
        limit = request.args.get("limit", 20, type=int)
        limit = max(1, min(limit, 100))
        page = max(1, page)
        total = len(sessions)
        pages = math.ceil(total / limit) if total else 1
        start = (page - 1) * limit
        return jsonify({
            "sessions": sessions[start:start + limit],
            "total": total,
            "page": page,
            "pages": pages,
        })

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

    @app.route("/api/sounds")
    def api_sounds():
        """Return short names of available sound effects in static/audio/."""
        audio_dir = os.path.join(app.static_folder, "audio")
        if not os.path.isdir(audio_dir):
            return jsonify([])
        sounds = []
        for fname in sorted(os.listdir(audio_dir)):
            if not fname.endswith(".mp3"):
                continue
            name = fname.rsplit(".", 1)[0]
            sounds.append({"name": name, "file": fname})
        return jsonify(sounds)

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

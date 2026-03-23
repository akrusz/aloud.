"""HTTP route handlers for the Flask web application."""

import math
import os
import platform
import shutil
import subprocess
import time

import httpx
from flask import Flask, render_template, request, jsonify, Response, redirect, url_for

from .. import __version__
from ..config import (
    has_user_config, save_user_config,
    config_to_dict, load_config, get_user_config_path,
    sync_api_key_to_env,
)
from ..tts import create_tts
from ..updater import check_for_updates, apply_update, download_release

from ..config import DEFAULT_OLLAMA_TIERS


def _get_system_ram_gb() -> int | None:
    """Return total system RAM in whole GB, or None if unknown."""
    try:
        if platform.system() == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return int(out.strip()) // (1024 ** 3)
        # Linux / other POSIX
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return (pages * page_size) // (1024 ** 3)
    except Exception:
        pass
    return None


def _recommended_ollama_model(ram_gb: int | None, tiers: list[dict]) -> dict:
    """Pick the best Ollama model tier for the given RAM."""
    if ram_gb is None:
        return tiers[-1]  # default to smallest
    for tier in tiers:
        if ram_gb >= tier["min_gb"]:
            return tier
    return tiers[-1]


def register_routes(app: Flask) -> None:
    """Register all HTTP routes on the Flask app."""

    @app.route("/")
    def index():
        # First-run: redirect to settings if no user config exists
        if not has_user_config():
            return redirect(url_for("settings_page"))
        return render_template("index.html")

    @app.route("/session")
    def session_page():
        return render_template("session.html")

    @app.route("/history")
    def history_page():
        return render_template("history.html")

    @app.route("/settings")
    def settings_page():
        first_run = not has_user_config()
        return render_template("settings.html", first_run=first_run)

    @app.route("/api/config", methods=["GET"])
    def api_config_get():
        """Return the current merged configuration (with API keys masked)."""
        cfg = config_to_dict(app.meditation_config)
        # Mask sensitive fields
        if cfg.get("llm", {}).get("api_key"):
            key = cfg["llm"]["api_key"]
            if len(key) > 8:
                cfg["llm"]["api_key"] = key[:4] + "..." + key[-4:]
            else:
                cfg["llm"]["api_key"] = "***"
        if cfg.get("tts", {}).get("api_key"):
            key = cfg["tts"]["api_key"]
            if len(key) > 8:
                cfg["tts"]["api_key"] = key[:4] + "..." + key[-4:]
            else:
                cfg["tts"]["api_key"] = "***"
        cfg["_has_user_config"] = has_user_config()
        cfg["_config_path"] = str(get_user_config_path())
        return jsonify(cfg)

    @app.route("/api/config", methods=["POST"])
    def api_config_save():
        """Save user configuration overrides."""
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        try:
            path = save_user_config(data)

            # Reload config into the running app
            new_config = load_config()
            app.meditation_config = new_config
            app.jinja_env.globals["text_scale"] = new_config.web.text_scale
            sync_api_key_to_env(new_config)

            # Recreate server TTS if the engine/voice/rate changed
            try:
                app.server_tts = create_tts(
                    engine=new_config.tts.engine,
                    voice=new_config.tts.voice,
                    rate=new_config.tts.rate,
                )
            except Exception:
                app.server_tts = None

            return jsonify({"saved": True, "path": str(path)})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/close-window", methods=["POST"])
    def api_close_window():
        """Close the pywebview window (shuts down the app)."""
        window = getattr(app, "webview_window", None)
        if not window:
            # Not in desktop mode — just shut down the server
            import signal
            os.kill(os.getpid(), signal.SIGINT)
            return jsonify({"ok": True})
        try:
            window.destroy()
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/toggle-fullscreen", methods=["POST"])
    def api_toggle_fullscreen():
        """Toggle fullscreen mode in the pywebview window."""
        window = getattr(app, "webview_window", None)
        if not window:
            return jsonify({"error": "Not running in desktop mode"}), 400
        try:
            window.toggle_fullscreen()
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    def _find_cli_proxy() -> str | None:
        """Find CLIProxyAPI, searching beyond the app bundle's limited PATH."""
        binary = shutil.which("CLIProxyAPI")
        if binary:
            return binary
        # macOS app bundles have a minimal PATH — ask the user's login shell
        try:
            result = subprocess.run(
                ["/bin/zsh", "-lc", "which CLIProxyAPI"],
                capture_output=True, text=True, timeout=5,
            )
            path = result.stdout.strip()
            if result.returncode == 0 and path and os.path.isfile(path):
                return path
        except Exception:
            pass
        return None

    @app.route("/api/proxy/status")
    def api_proxy_status():
        """Check if CLIProxyAPI is installed and/or running."""
        binary = _find_cli_proxy()
        installed = binary is not None

        running = False
        proxy_url = app.meditation_config.llm.proxy_url or "http://127.0.0.1:8317"
        headers = {}
        if app.meditation_config.llm.api_key:
            headers["X-Api-Key"] = app.meditation_config.llm.api_key
        try:
            resp = httpx.get(
                f"{proxy_url.rstrip('/')}/v1/models",
                headers=headers,
                timeout=2.0,
            )
            running = resp.status_code == 200
        except Exception:
            pass

        return jsonify({
            "installed": installed,
            "running": running,
            "path": binary,
        })

    @app.route("/api/proxy/start", methods=["POST"])
    def api_proxy_start():
        """Start CLIProxyAPI if installed and not already running."""
        binary = _find_cli_proxy()
        if not binary:
            return jsonify({"ok": False, "message": "CLIProxyAPI not found on this system"}), 404

        # Check if already running
        proxy_url = app.meditation_config.llm.proxy_url or "http://127.0.0.1:8317"
        headers = {}
        if app.meditation_config.llm.api_key:
            headers["X-Api-Key"] = app.meditation_config.llm.api_key
        try:
            resp = httpx.get(
                f"{proxy_url.rstrip('/')}/v1/models",
                headers=headers,
                timeout=2.0,
            )
            if resp.status_code == 200:
                return jsonify({"ok": True, "message": "Already running"})
        except Exception:
            pass

        # Start as a child process — cleaned up when Glooow exits via atexit
        try:
            import atexit

            proc = subprocess.Popen(
                [binary],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            app.proxy_process = proc

            def _cleanup_proxy():
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except Exception:
                        proc.kill()

            atexit.register(_cleanup_proxy)
            # Wait briefly for it to come up
            for _ in range(10):
                time.sleep(0.5)
                try:
                    resp = httpx.get(
                        f"{proxy_url.rstrip('/')}/v1/models",
                        headers=headers,
                        timeout=1.0,
                    )
                    if resp.status_code == 200:
                        return jsonify({"ok": True, "message": "Started"})
                except Exception:
                    continue
            return jsonify({"ok": False, "message": "Started but not responding yet — try refreshing in a moment"})
        except Exception as e:
            return jsonify({"ok": False, "message": str(e)}), 500

    @app.route("/api/providers")
    def api_providers():
        """Return provider availability based on env vars / proxy reachability."""
        results = {}

        refresh = ' <a href="#" onclick="refreshProviders(); return false">Refresh</a>'
        proxy_binary = _find_cli_proxy()

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
            if resp.status_code == 200:
                results["claude_proxy"] = {"available": True, "installed": True, "hint": ""}
            else:
                results["claude_proxy"] = {
                    "available": False, "installed": bool(proxy_binary),
                    "hint": (
                        "CLIProxyAPI rejected the connection. Check your config in "
                        "<code>~/.cli-proxy-api/config.yaml</code>." + refresh
                    ),
                }
        except Exception:
            if proxy_binary:
                start_btn = (
                    ' <a href="#" onclick="startProxy(); return false" '
                    'class="btn btn-small btn-primary" '
                    'style="display:inline-block; margin-left:0.5rem; padding:0.15rem 0.6rem; '
                    'font-size:0.875rem; vertical-align:baseline">Start</a>'
                )
                results["claude_proxy"] = {
                    "available": False, "installed": True,
                    "hint": "CLIProxyAPI is installed but not running." + start_btn,
                }
            else:
                results["claude_proxy"] = {
                    "available": False, "installed": False,
                    "hint": (
                        "Requires <a href='https://github.com/router-for-me/CLIProxyAPI' "
                        "target='_blank'>CLIProxyAPI</a>. "
                        "Install it, start it, then:" + refresh
                    ),
                }

        # anthropic — needs ANTHROPIC_API_KEY
        results["anthropic"] = {
            "available": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>ANTHROPIC_API_KEY</code> in your environment."
            ),
        }

        # openai — needs OPENAI_API_KEY
        results["openai"] = {
            "available": bool(os.environ.get("OPENAI_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>OPENAI_API_KEY</code> in your environment."
            ),
        }

        # openrouter — needs OPENROUTER_API_KEY
        results["openrouter"] = {
            "available": bool(os.environ.get("OPENROUTER_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>OPENROUTER_API_KEY</code> in your environment."
            ),
        }

        # venice — needs VENICE_API_KEY
        results["venice"] = {
            "available": bool(os.environ.get("VENICE_API_KEY")),
            "hint": (
                "Add your API key in <a href='/settings'>Settings</a> "
                "or set <code>VENICE_API_KEY</code> in your environment."
            ),
        }

        # ollama — check if server is running and list pulled models
        tiers = app.meditation_config.llm.ollama_tiers or DEFAULT_OLLAMA_TIERS
        ram_gb = _get_system_ram_gb()
        rec = _recommended_ollama_model(ram_gb, tiers)
        rec_info = {
            "ram_gb": ram_gb,
            "recommended_model": rec["model"],
            "recommended_label": rec["label"],
            "tiers": [
                {
                    "model": t["model"], "label": t["label"],
                    "download": t["download"], "disk": t["disk"],
                    "ram": t["ram"], "note": t.get("note", ""),
                    "min_gb": t["min_gb"],
                    "fits": ram_gb is not None and ram_gb >= t["min_gb"],
                }
                for t in tiers
            ],
        }

        ollama_url = app.meditation_config.llm.ollama_url or "http://localhost:11434"
        try:
            resp = httpx.get(f"{ollama_url.rstrip('/')}/api/tags", timeout=2.0)
            resp.raise_for_status()
            raw_models = resp.json().get("models", [])
            models = [m["name"] for m in raw_models]
            # Build a name→disk-size map for pulled models
            model_sizes = {}
            for m in raw_models:
                size_bytes = m.get("size", 0)
                if size_bytes > 0:
                    gb = size_bytes / (1024 ** 3)
                    model_sizes[m["name"]] = (
                        f"{gb:.1f}GB" if gb >= 1 else f"{size_bytes / (1024**2):.0f}MB"
                    )
            # Mark which tiers are already installed
            pulled_set = {n.split(":")[0] for n in models}
            for t in rec_info["tiers"]:
                tier_base = t["model"].split(":")[0]
                t["installed"] = any(
                    n.split(":")[0] == tier_base and t["model"].split(":")[-1] in n
                    for n in models
                )
                # Use actual disk size if available
                for name, size_str in model_sizes.items():
                    if name == t["model"] or name.startswith(tier_base + ":"):
                        t["actual_disk"] = size_str
                        break

            if models:
                results["ollama"] = {
                    "available": True, "models": models, "hint": "",
                    "model_sizes": model_sizes,
                    "recommendation": rec_info,
                }
            else:
                results["ollama"] = {
                    "available": False, "models": [],
                    "hint": (
                        "Ollama is running but has no models. "
                        "Download one below, or run: "
                        f"<code>ollama pull {rec['model']}</code>" + refresh
                    ),
                    "recommendation": rec_info,
                }
        except Exception:
            results["ollama"] = {
                "available": False, "models": [],
                "hint": (
                    "Ollama is not running. Install from "
                    "<a href='https://ollama.ai' target='_blank'>ollama.ai</a>, "
                    "start it, then:" + refresh
                ),
                "recommendation": rec_info,
            }

        return jsonify(results)

    @app.route("/api/ollama/pull", methods=["POST"])
    def api_ollama_pull():
        """Stream an Ollama model pull, proxying progress from Ollama's API."""
        import json as _json

        data = request.get_json(silent=True) or {}
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"error": "model is required"}), 400

        ollama_url = (
            app.meditation_config.llm.ollama_url or "http://localhost:11434"
        )

        def generate():
            try:
                with httpx.stream(
                    "POST",
                    f"{ollama_url.rstrip('/')}/api/pull",
                    json={"model": model, "stream": True},
                    timeout=httpx.Timeout(10.0, read=600.0),
                ) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        obj = _json.loads(line)
                        # Forward a simplified progress object
                        out = {"status": obj.get("status", "")}
                        if "total" in obj and "completed" in obj:
                            out["total"] = obj["total"]
                            out["completed"] = obj["completed"]
                        yield _json.dumps(out) + "\n"
            except httpx.HTTPStatusError as exc:
                yield _json.dumps({
                    "status": "error",
                    "error": f"Ollama returned {exc.response.status_code}",
                }) + "\n"
            except Exception as exc:
                yield _json.dumps({
                    "status": "error",
                    "error": str(exc),
                }) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.route("/api/ollama/delete", methods=["POST"])
    def api_ollama_delete():
        """Delete a pulled Ollama model."""
        data = request.get_json(silent=True) or {}
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"error": "model is required"}), 400

        ollama_url = (
            app.meditation_config.llm.ollama_url or "http://localhost:11434"
        )
        try:
            resp = httpx.delete(
                f"{ollama_url.rstrip('/')}/api/delete",
                json={"model": model},
                timeout=30.0,
            )
            resp.raise_for_status()
            return jsonify({"ok": True})
        except httpx.HTTPStatusError as exc:
            return jsonify({"error": f"Ollama returned {exc.response.status_code}"}), 502
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    @app.route("/api/sessions")
    def api_sessions():
        sessions = app.transcript_logger.list_sessions()
        # Filter to this client's sessions (LAN privacy)
        client_id = request.args.get("client_id")
        if client_id:
            sessions = [s for s in sessions if s.get("client_id") == client_id]
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
        """Return voices available to the server-side TTS engine.

        Optional query param ?lang=en filters to voices matching that language prefix.
        """
        if not app.server_tts or not hasattr(app.server_tts, "list_voices"):
            return jsonify([])
        voices = app.server_tts.list_voices()
        lang_filter = request.args.get("lang")
        if lang_filter:
            voices = [
                v for v in voices
                if v.get("lang", "").split("_")[0] == lang_filter
            ]
        return jsonify(voices)

    @app.route("/api/voices/preview")
    def api_voice_preview():
        """Generate a short TTS preview for a given voice."""
        voice = request.args.get("voice")
        if not voice or not app.server_tts or not hasattr(app.server_tts, "speak_to_bytes"):
            return Response(status=404)

        default_text = _preview_text_for_voice(voice, app.server_tts)
        text = request.args.get("text", default_text)

        # Temporarily switch voice and rate, generate audio, then restore
        original_voice = app.server_tts.voice
        original_rate = getattr(app.server_tts, 'rate', None)
        app.server_tts.set_voice(voice)
        rate = request.args.get("rate", type=int)
        if rate and hasattr(app.server_tts, "set_rate"):
            app.server_tts.set_rate(rate)
        try:
            audio = app.server_tts.speak_to_bytes(text)
        finally:
            app.server_tts.set_voice(original_voice)
            if original_rate is not None and hasattr(app.server_tts, "set_rate"):
                app.server_tts.set_rate(original_rate)

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
            "is_release": status.is_release,
            "current_version": status.current_version,
            "latest_version": status.latest_version,
            "release_notes": status.release_notes,
            "download_url": status.download_url,
            "download_size": status.download_size,
            "asset_name": status.asset_name,
        })

    @app.route("/api/update/apply", methods=["POST"])
    def api_update_apply():
        data = request.get_json(silent=True) or {}
        url = data.get("download_url", "")
        name = data.get("asset_name", "")

        if url:
            result = download_release(url, name)
        else:
            result = apply_update()

        return jsonify({
            "success": result.success,
            "message": result.message,
            "needs_restart": result.needs_restart,
        })

    @app.route("/api/lan-info")
    def api_lan_info():
        """Return LAN connection info for sharing."""
        import socket
        port = app.meditation_config.web.port
        https_port = getattr(app, "https_port", None)
        try:
            local_ip = socket.gethostbyname(socket.gethostname())
        except socket.gaierror:
            local_ip = None
        return jsonify({
            "ip": local_ip,
            "port": port,
            "https_port": https_port,
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


# ---- Localized preview text ----

_PREVIEW_TEXTS = {
    "en": "Welcome to Glow. I'll be your guide.",
    "es": "Bienvenido a Glow. Seré tu guía.",
    "fr": "Bienvenue sur Glow. Je serai votre guide.",
    "de": "Willkommen bei Glow. Ich werde dein Begleiter sein.",
    "it": "Benvenuto su Glow. Sarò la tua guida.",
    "pt": "Bem-vindo ao Glow. Eu serei o seu guia.",
    "nl": "Welkom bij Glow. Ik zal je gids zijn.",
    "pl": "Witaj w Glow. Będę twoim przewodnikiem.",
    "ru": "Добро пожаловать в Glow. Я буду вашим проводником.",
    "uk": "Ласкаво просимо до Glow. Я буду вашим провідником.",
    "ja": "グロウへようこそ。私があなたのガイドです。",
    "zh": "欢迎来到Glow。我将是你的向导。",
    "ko": "글로우에 오신 것을 환영합니다. 제가 안내해 드리겠습니다.",
    "ar": "مرحباً بك في غلوو. سأكون دليلك.",
    "hi": "ग्लूव में आपका स्वागत है। मैं आपका मार्गदर्शक रहूँगा।",
    "tr": "Glow'a hoş geldiniz. Rehberiniz ben olacağım.",
    "vi": "Chào mừng bạn đến với Glow. Tôi sẽ là hướng dẫn viên của bạn.",
    "th": "ยินดีต้อนรับสู่ Glow ฉันจะเป็นผู้นำทางของคุณ",
    "sv": "Välkommen till Glow. Jag kommer att vara din guide.",
    "da": "Velkommen til Glow. Jeg vil være din guide.",
    "no": "Velkommen til Glow. Jeg vil være din guide.",
    "fi": "Tervetuloa Glowiin. Minä olen oppaasi.",
    "el": "Καλώς ήρθατε στο Glow. Θα είμαι ο οδηγός σας.",
    "he": "ברוכים הבאים ל-Glow. אני אהיה המדריך שלכם.",
    "cs": "Vítejte v Glow. Budu vaším průvodcem.",
    "ro": "Bun venit la Glow. Voi fi ghidul tău.",
    "hu": "Üdvözöljük a Glow-ban. Én leszek a kísérője.",
    "id": "Selamat datang di Glow. Saya akan menjadi pemandu Anda.",
    "ms": "Selamat datang ke Glow. Saya akan menjadi pemandu anda.",
    "ca": "Benvingut a Glow. Seré el teu guia.",
}


def _preview_text_for_voice(voice_name: str, tts) -> str:
    """Return a preview sentence in the voice's language."""
    # Look up the voice's language from the TTS engine
    if hasattr(tts, "list_voices"):
        for v in tts.list_voices():
            if v.get("name") == voice_name:
                lang_code = v.get("lang", "en_US").split("_")[0]
                return _PREVIEW_TEXTS.get(lang_code, _PREVIEW_TEXTS["en"])
    return _PREVIEW_TEXTS["en"]


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
    chat_prefixes = ("gpt-5", "gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt")
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

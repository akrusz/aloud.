"""HTTP route handlers for the Flask web application."""

import math
import os
import re

import httpx
from flask import Flask, render_template, request, jsonify, Response, redirect, url_for

from .. import __version__
from ..config import has_user_config
from ..updater import check_for_updates, apply_update, download_release, UpdateStatus, _load_cache

from .config_routes import register_config_routes
from .provider_routes import register_provider_routes
from .tool_routes import register_tool_routes


def register_routes(app: Flask) -> None:
    """Register all HTTP routes on the Flask app."""

    def _is_first_run():
        if getattr(app, "simulate_fresh", False):
            return True
        return not has_user_config()

    # Delegate to focused sub-modules
    register_config_routes(app)
    register_provider_routes(app)
    register_tool_routes(app)

    # ---- Page routes ----

    @app.route("/")
    def index():
        # First-run: redirect to settings if no user config exists
        if _is_first_run():
            return redirect(url_for("settings_page"))
        return render_template("index.html")

    @app.route("/session")
    def session_page():
        return render_template("session.html")

    @app.route("/sw.js")
    def service_worker():
        # Served from the origin root so the service worker's scope is '/'
        # — required to control all pages, not just /static/.
        body = render_template("sw.js")
        response = Response(body, mimetype="application/javascript")
        # SW spec requires the registration response not be served from
        # HTTP cache so users pick up changes promptly. We also set
        # Service-Worker-Allowed in case a future move puts the file
        # under a sub-path.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    @app.route("/history")
    def history_page():
        return render_template("history.html")

    @app.route("/settings")
    def settings_page():
        first_run = _is_first_run()
        from ..tts.piper import PiperTTS
        piper_available = PiperTTS.is_available() and not getattr(app, "reset_piper", False)
        return render_template("settings.html", first_run=first_run,
                               piper_available=piper_available)

    # ---- Window management ----

    @app.route("/api/close-window", methods=["POST"])
    def api_close_window():
        """Close the pywebview window (shuts down the app). Desktop mode only."""
        window = getattr(app, "webview_window", None)
        if not window:
            return jsonify({"error": "Not running in desktop mode"}), 400
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

    @app.route("/api/open-url", methods=["POST"])
    def api_open_url():
        """Open a URL in the system default handler (browser, email client, etc.)."""
        import subprocess
        import sys
        url = (request.json or {}).get("url", "")
        if not url:
            return jsonify({"error": "Missing url"}), 400
        if sys.platform == "darwin":
            subprocess.Popen(["open", url])
        else:
            import webbrowser
            webbrowser.open(url)
        return jsonify({"ok": True})

    # ---- Session history ----

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

    # ---- Voices ----

    @app.route("/api/voices")
    def api_voices():
        """Return voices available for TTS.

        Without query params, returns voices from **all** available local
        engines (macOS, Piper) plus ElevenLabs if active.

        Optional query params:
          ?lang=en    — filter to voices matching that language prefix
          ?engine=X   — list voices for engine X only (used by Settings)
        """
        engine_override = request.args.get("engine")

        if getattr(app, "no_voices", False):
            return jsonify([])

        if engine_override:
            # Settings page: return voices for a specific engine only
            tts = app.server_tts
            if engine_override != getattr(tts, 'engine', None):
                try:
                    from ..tts import create_tts
                    tts = create_tts(engine=engine_override)
                except Exception:
                    tts = None
            if not tts or not hasattr(tts, "list_voices"):
                return jsonify([])
            voices = tts.list_voices()
        else:
            # Index / session page: aggregate all available engines
            from ..tts import aggregate_voices
            voices = aggregate_voices(server_tts=app.server_tts)

        lang_filter = request.args.get("lang")
        if lang_filter:
            voices = [
                v for v in voices
                if v.get("lang", "").split("_")[0] == lang_filter
            ]
        if getattr(app, "hide_premium_voices", False):
            voices = [
                v for v in voices
                if not re.search(r"Premium|Enhanced", v.get("name", ""), re.IGNORECASE)
            ]
        if getattr(app, "reset_piper", False):
            for v in voices:
                if v.get("needs_download"):
                    v["downloaded"] = False
        return jsonify(voices)

    @app.route("/api/voices/preview")
    def api_voice_preview():
        """Generate a short TTS preview for a given voice."""
        voice = request.args.get("voice")
        if not voice:
            return Response(status=404)

        # Use the requested engine if specified, otherwise auto-detect
        engine_override = request.args.get("engine")
        tts = app.server_tts
        is_temp = False

        # Auto-detect the right engine when none specified
        if not engine_override:
            from ..tts import engine_for_voice
            detected = engine_for_voice(voice)
            if detected and not isinstance(tts, _tts_class_for(detected)):
                engine_override = detected

        if engine_override:
            try:
                from ..tts import create_tts
                tts = create_tts(engine=engine_override, voice=voice)
                is_temp = True
            except Exception:
                tts = None

        if not tts or not hasattr(tts, "speak_to_bytes"):
            return Response(status=404)

        default_text = _preview_text_for_voice(voice, tts)
        text = request.args.get("text", default_text)
        rate = request.args.get("rate", type=int)

        if is_temp:
            # Temporary instance — no need to save/restore state
            if rate and hasattr(tts, "set_rate"):
                tts.set_rate(rate)
            audio = tts.speak_to_bytes(text)
        else:
            # Shared instance — save/restore voice and rate
            original_voice = tts.voice
            original_rate = getattr(tts, 'rate', None)
            tts.set_voice(voice)
            if rate and hasattr(tts, "set_rate"):
                tts.set_rate(rate)
            try:
                audio = tts.speak_to_bytes(text)
            finally:
                tts.set_voice(original_voice)
                if original_rate is not None and hasattr(tts, "set_rate"):
                    tts.set_rate(original_rate)

        if not audio:
            return Response(status=500)
        return Response(audio, mimetype="audio/wav")

    # ---- TTS model downloads ----

    @app.route("/api/tts/download-model", methods=["POST"])
    def api_tts_download_model():
        """Stream a TTS model download with progress."""
        import json as _json

        data = request.get_json(silent=True) or {}
        engine = data.get("engine", "").strip()
        voice = data.get("voice", "").strip()

        if not engine or not voice:
            return jsonify({"error": "engine and voice are required"}), 400

        def generate():
            try:
                if engine == "piper":
                    from ..tts.piper import PiperTTS, _get_piper_models_dir, _voice_hf_urls
                    if PiperTTS.is_model_downloaded(voice) and not getattr(app, "reset_piper", False):
                        yield _json.dumps({"status": "already_downloaded"}) + "\n"
                        return

                    models_dir = _get_piper_models_dir()
                    models_dir.mkdir(parents=True, exist_ok=True)
                    files = _voice_hf_urls(voice)
                    total_downloaded = 0

                    for url, filename in files:
                        dest = models_dir / filename
                        tmp = dest.with_suffix(".part")
                        try:
                            with httpx.stream("GET", url, follow_redirects=True, timeout=120) as resp:
                                resp.raise_for_status()
                                file_total = int(resp.headers.get("content-length", 0))
                                with open(tmp, "wb") as f:
                                    for chunk in resp.iter_bytes(chunk_size=64 * 1024):
                                        f.write(chunk)
                                        total_downloaded += len(chunk)
                                        yield _json.dumps({
                                            "status": "downloading",
                                            "total": file_total,
                                            "completed": total_downloaded,
                                            "file": filename,
                                        }) + "\n"
                            tmp.rename(dest)
                        except Exception:
                            tmp.unlink(missing_ok=True)
                            raise

                    yield _json.dumps({"status": "done"}) + "\n"

                else:
                    yield _json.dumps({"status": "error", "error": f"Unknown engine: {engine}"}) + "\n"

            except Exception as exc:
                yield _json.dumps({"status": "error", "error": str(exc)}) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.route("/api/tts/uninstall-model", methods=["POST"])
    def api_tts_uninstall_model():
        """Remove a downloaded TTS voice model."""
        data = request.get_json(silent=True) or {}
        voice = data.get("voice", "").strip()
        engine = data.get("engine", "").strip()

        if not voice:
            return jsonify({"error": "voice is required"}), 400

        if engine == "piper":
            from ..tts.piper import _get_piper_models_dir
            models_dir = _get_piper_models_dir()
            removed = False
            for suffix in (".onnx", ".onnx.json"):
                f = models_dir / (voice + suffix)
                if f.exists():
                    f.unlink()
                    removed = True
            return jsonify({"status": "removed" if removed else "not_found"})

        return jsonify({"error": "uninstall not supported for this engine"}), 400

    @app.route("/api/open-voice-settings", methods=["POST"])
    def api_open_voice_settings():
        """Open macOS System Settings to the Spoken Content pane."""
        import subprocess
        import sys as _sys
        if _sys.platform != "darwin":
            return jsonify({"error": "macOS only"}), 400
        subprocess.Popen([
            "open",
            "x-apple.systempreferences:com.apple.preference.universalaccess?TextToSpeech",
        ])
        return jsonify({"status": "ok"})

    # ---- Updates ----

    @app.route("/api/update/check")
    def api_update_check():
        force = request.args.get("force", "0") == "1"

        if force:
            # User explicitly clicked "check for updates" — OK to block
            status = check_for_updates(force=True)
        else:
            # Page-load check: return cached result immediately so we
            # never block the HTTP thread (the background startup task
            # populates the cache).  If no cache yet, return empty.
            cached = _load_cache()
            status = UpdateStatus(
                available=cached["available"],
                commits_behind=cached["commits_behind"],
                commit_messages=cached.get("commit_messages", []),
                current_sha=cached.get("current_sha", ""),
                remote_sha=cached.get("remote_sha", ""),
                is_git=cached.get("is_git", True),
                is_release=cached.get("is_release", False),
                current_version=cached.get("current_version", ""),
                latest_version=cached.get("latest_version", ""),
                release_notes=cached.get("release_notes", ""),
                download_url=cached.get("download_url", ""),
                download_size=cached.get("download_size", 0),
                asset_name=cached.get("asset_name", ""),
            ) if cached else UpdateStatus()

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

    # ---- Misc utilities ----

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


def _tts_class_for(engine_name: str) -> type:
    """Return the TTS class for an engine name (for isinstance checks)."""
    if engine_name == "piper":
        from ..tts.piper import PiperTTS
        return PiperTTS
    if engine_name == "elevenlabs":
        from ..tts.elevenlabs import ElevenLabsTTS
        return ElevenLabsTTS
    if engine_name == "macos":
        from ..tts.macos import MacOSTTS
        return MacOSTTS
    return type(None)


def _preview_text_for_voice(voice_name: str, tts) -> str:
    """Return a preview sentence in the voice's language."""
    # Look up the voice's language from the TTS engine
    if hasattr(tts, "list_voices"):
        for v in tts.list_voices():
            if v.get("name") == voice_name:
                lang_code = v.get("lang", "en_US").split("_")[0]
                return _PREVIEW_TEXTS.get(lang_code, _PREVIEW_TEXTS["en"])
    return _PREVIEW_TEXTS["en"]

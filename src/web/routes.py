"""HTTP route handlers for the Flask web application."""

import math
import os

from flask import Flask, render_template, request, jsonify, Response, redirect, url_for

from .. import __version__
from ..config import has_user_config
from ..updater import check_for_updates, apply_update, download_release

from .config_routes import register_config_routes
from .provider_routes import register_provider_routes
from .tool_routes import register_tool_routes


def register_routes(app: Flask) -> None:
    """Register all HTTP routes on the Flask app."""

    # Delegate to focused sub-modules
    register_config_routes(app)
    register_provider_routes(app)
    register_tool_routes(app)

    # ---- Page routes ----

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
        """Return voices available to a TTS engine.

        Optional query params:
          ?lang=en    — filter to voices matching that language prefix
          ?engine=X   — list voices for engine X without changing server state
        """
        engine_override = request.args.get("engine")
        tts = app.server_tts

        if engine_override and engine_override != getattr(tts, 'engine', None):
            # Temporarily create the requested engine to query its voices
            try:
                from ..tts import create_tts
                tts = create_tts(engine=engine_override)
            except Exception:
                tts = None

        if not tts or not hasattr(tts, "list_voices"):
            return jsonify([])
        voices = tts.list_voices()
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

    # ---- Updates ----

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


def _preview_text_for_voice(voice_name: str, tts) -> str:
    """Return a preview sentence in the voice's language."""
    # Look up the voice's language from the TTS engine
    if hasattr(tts, "list_voices"):
        for v in tts.list_voices():
            if v.get("name") == voice_name:
                lang_code = v.get("lang", "en_US").split("_")[0]
                return _PREVIEW_TEXTS.get(lang_code, _PREVIEW_TEXTS["en"])
    return _PREVIEW_TEXTS["en"]

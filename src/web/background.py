"""Background tasks launched during app startup.

Extracted from app.py to keep create_app() focused on app configuration.
"""

import logging

from ..config import Config
from ..facilitation.pacing import TurnDecision
from ..updater import check_for_updates

logger = logging.getLogger(__name__)


def start_background_tasks(app, socketio, config: Config) -> None:
    """Kick off all background tasks: check-in loop, update check, whisper."""
    socketio.start_background_task(_check_in_loop, app, socketio)
    socketio.start_background_task(_startup_update_check)
    socketio.start_background_task(_load_whisper, app, socketio)


def _check_in_loop(app, socketio) -> None:
    """Background loop that checks for extended silence and sends check-ins."""
    from .socketio_handlers import speak_to_audio

    while True:
        socketio.sleep(10)  # check every 10 seconds
        for session_id, web_session in list(app.web_sessions.items()):
            if web_session.client_muted:
                continue
            if web_session.meditation_type == "noting":
                continue
            if not web_session.config.pacing.silence_checkins_enabled:
                continue
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
                audio = speak_to_audio(app, web_session, check_in)
                socketio.emit("facilitator_message", {
                    "text": check_in,
                    "type": "response",
                    "audio": audio,
                }, to=sid)
                web_session.pacing.on_response_end()


def _startup_update_check() -> None:
    """Background startup check -- log if update available."""
    try:
        status = check_for_updates()
        if status.available:
            if status.is_release:
                logger.info("Update available: v%s → v%s", status.current_version, status.latest_version)
            else:
                logger.info("Update available (%d commit(s) behind)", status.commits_behind)
    except Exception as e:
        logger.debug("Startup update check failed: %s", e)


def _load_whisper(app, socketio) -> None:
    """Load Whisper model in background so startup isn't blocked."""
    def _on_progress(phase, pct):
        socketio.emit("stt_progress", {"phase": phase, "progress": pct})

    app.whisper_stt.progress_callback = _on_progress
    try:
        app.whisper_stt._load_model()
        app.whisper_model_ready = True
        socketio.emit("stt_ready", {})
        logger.info("Whisper model loaded")
    except Exception as e:
        logger.error("Failed to load Whisper model: %s", e)
        socketio.emit("stt_error", {"error": str(e)})

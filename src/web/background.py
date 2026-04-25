"""Background tasks launched during app startup.

Extracted from app.py to keep create_app() focused on app configuration.
"""

import atexit
import logging
import subprocess
import time

import httpx

from ..config import Config
from ..facilitation.pacing import TurnDecision
from ..updater import check_for_updates
from .provider_routes import find_cli_proxy

logger = logging.getLogger(__name__)


def start_background_tasks(app, socketio, config: Config) -> None:
    """Kick off all background tasks: check-in loop, update check, proxy, whisper."""
    socketio.start_background_task(_check_in_loop, app, socketio)
    socketio.start_background_task(_startup_update_check)
    socketio.start_background_task(_auto_start_proxy, app, config)
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
                web_session.pacing.on_check_in()
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


def _auto_start_proxy(app, config: Config) -> None:
    """Auto-start CLIProxyAPI if configured, installed, and not already running."""
    if not config.web.auto_start_proxy:
        return

    binary = find_cli_proxy()
    if not binary:
        return

    from ..llm.claude_proxy import PROXY_API_KEY
    proxy_url = config.llm.proxy_url or "http://127.0.0.1:8317"
    headers = {"X-Api-Key": PROXY_API_KEY}

    # Check if already running
    try:
        resp = httpx.get(
            f"{proxy_url.rstrip('/')}/v1/models",
            headers=headers,
            timeout=2.0,
        )
        if resp.status_code == 200:
            logger.info("CLIProxyAPI already running")
            return
    except Exception as e:
        logger.debug("CLIProxyAPI not reachable, will attempt start: %s", e)

    # Start it
    try:
        proc = subprocess.Popen(
            [binary],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        app.proxy_process = proc

        def _cleanup():
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except Exception as e:
                    logger.debug("Proxy did not exit gracefully, killing: %s", e)
                    proc.kill()

        atexit.register(_cleanup)

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
                    logger.info("Auto-started CLIProxyAPI (pid=%d)", proc.pid)
                    return
            except Exception:
                continue
        logger.info("Auto-started CLIProxyAPI (pid=%d) — not responding yet", proc.pid)
    except Exception as e:
        logger.warning("Failed to auto-start CLIProxyAPI: %s", e)


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

"""WebSocket event handlers for the Flask-SocketIO application.

This module is the coordinator: it exposes the shared ``get_session`` helper
and the ``register_socketio_events`` entry-point that delegates to focused
handler modules.
"""

import logging

from flask import Flask
from flask_socketio import SocketIO

logger = logging.getLogger(__name__)

NO_AI_SUMMARY = "No summary \u2014 no AI provider was used this session."


def get_session(app: Flask, sid: str):
    """Look up a WebMeditationSession by socket sid."""
    session_id = app.sid_to_session.get(sid)
    if session_id:
        return app.web_sessions.get(session_id)
    return None


def speak_to_audio(app: Flask, web_session, text: str, voice: str | None = None):
    """Generate TTS audio bytes, or None if TTS is disabled/unavailable.

    Checks that the session has TTS enabled, that the server TTS engine
    exists, and that it supports ``speak_to_bytes``.  Uses the session's
    voice (or an explicit override) without mutating global TTS state.
    """
    if not (web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes')):
        return None
    tts = app.server_tts
    # Determine which voice to use: explicit override > session voice > current
    target_voice = voice or web_session.tts_voice_name
    original_voice = tts.voice
    try:
        if target_voice and target_voice != original_voice:
            tts.set_voice(target_voice)
        return tts.speak_to_bytes(text)
    finally:
        if target_voice and target_voice != original_voice:
            tts.set_voice(original_voice)


def register_socketio_events(socketio: SocketIO, app: Flask) -> None:
    """Register all WebSocket event handlers via sub-registrars."""
    from .session_handlers import register_session_handlers
    from .audio_handlers import register_audio_handlers
    from .message_handlers import register_message_handlers

    register_session_handlers(socketio, app)
    register_audio_handlers(socketio, app)
    register_message_handlers(socketio, app)

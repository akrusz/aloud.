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

    When the voice belongs to a different engine (e.g. a macOS Premium
    voice while Piper is active), a temporary TTS instance is created
    for that engine.  Falls back to the primary engine's default voice
    only if all else fails.
    """
    if not web_session.tts_enabled:
        return None
    tts = app.server_tts
    if not tts or not hasattr(tts, 'speak_to_bytes'):
        return None
    # Determine which voice to use: explicit override > session voice > current
    target_voice = voice or web_session.tts_voice_name
    original_voice = tts.voice
    try:
        if target_voice and target_voice != original_voice:
            tts.set_voice(target_voice)
        result = tts.speak_to_bytes(text)
        # If synthesis failed, try the correct engine for this voice
        if result is None and target_voice:
            from ..tts import engine_for_voice, create_tts
            fallback_engine = engine_for_voice(target_voice)
            if fallback_engine:
                try:
                    alt_tts = create_tts(
                        engine=fallback_engine,
                        voice=target_voice,
                        rate=int(getattr(tts, 'rate', 180)),
                    )
                    if alt_tts and hasattr(alt_tts, 'speak_to_bytes'):
                        result = alt_tts.speak_to_bytes(text)
                except Exception:
                    pass
        # Last resort: fall back to the primary engine's default voice
        if result is None and target_voice and target_voice != original_voice:
            import logging
            logging.getLogger(__name__).warning(
                "TTS voice '%s' failed, falling back to '%s'", target_voice, original_voice)
            tts.set_voice(original_voice)
            result = tts.speak_to_bytes(text)
        return result
    except Exception:
        import logging
        logging.getLogger(__name__).exception("TTS error")
        return None
    finally:
        if tts.voice != original_voice:
            tts.set_voice(original_voice)


def register_socketio_events(socketio: SocketIO, app: Flask) -> None:
    """Register all WebSocket event handlers via sub-registrars."""
    from .session_handlers import register_session_handlers
    from .audio_handlers import register_audio_handlers
    from .message_handlers import register_message_handlers

    register_session_handlers(socketio, app)
    register_audio_handlers(socketio, app)
    register_message_handlers(socketio, app)

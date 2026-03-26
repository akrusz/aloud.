"""Session lifecycle WebSocket event handlers.

Handles: connect, disconnect, start_session, end_session, prefetch_summary.
"""

import asyncio
import logging

from flask import Flask, request
from flask_socketio import SocketIO, emit

from .meditation_session import WebMeditationSession, _migrate_style
from .socketio_handlers import get_session, speak_to_audio, NO_AI_SUMMARY

logger = logging.getLogger(__name__)


def register_session_handlers(socketio: SocketIO, app: Flask) -> None:
    """Register session lifecycle event handlers."""

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
            logger.info("Reconnected sid=%s… to session %s…", sid[:8], session_id[:12])
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
            meditation_type=data.get("meditation_type", "exploration"),
        )

        if not session_id:
            session_id = sid  # fallback
        web_session.client_id = data.get("client_id")
        app.web_sessions[session_id] = web_session
        app.sid_to_session[sid] = session_id
        app.session_to_sid[session_id] = sid
        logger.info("New session %s… for sid=%s…", session_id[:12], sid[:8])

        # Send pacing config and TTS settings to the client
        emit("session_config", {
            "silence_base_ms": config.pacing.silence_base_ms,
            "silence_max_ms": config.pacing.silence_max_ms,
            "tts_rate": config.tts.rate,
            "tts_engine": config.tts.engine,
        })

        # If whisper already loaded, tell this client immediately
        # (the broadcast stt_ready may have fired before they connected)
        if app.whisper_model_ready:
            emit("stt_ready", {})

        # Restore voice name so easter egg persona works from the first message
        voice_name = data.get("voice_name")
        if voice_name:
            web_session.tts_voice_name = voice_name

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
                logger.info("Continuing from %s… (%d exchanges)", continue_from[:12], len(old_session['exchanges']))

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

                audio = speak_to_audio(app, web_session, response)
                emit("facilitator_message", {"text": response, "type": "opener", "audio": audio})
                web_session.pacing.on_response_end()
                return

        # Noting sessions use a static opener so we never hit the LLM
        # (the circle may have zero AI participants).
        if web_session.meditation_type == "noting":
            opener = web_session.get_opener()
        else:
            emit("facilitator_typing", {"typing": True})
            try:
                opener = asyncio.run(web_session.generate_opener())
            except Exception as e:
                logger.error("Failed to generate opener: %s", e)
                emit("facilitator_typing", {"typing": False})
                emit("error", {
                    "type": "llm",
                    "message": (
                        "Could not reach the LLM provider. "
                        "Check your provider and API key in Settings."
                    ),
                })
                return

        audio = speak_to_audio(app, web_session, opener)
        emit("facilitator_message", {"text": opener, "type": "opener", "audio": audio})
        web_session.pacing.on_response_end()

    @socketio.on("prefetch_summary")
    def handle_prefetch_summary():
        """Pre-generate a session summary while the user is in a confirm dialog.

        Caches the result on the web_session so handle_end_session can skip
        the LLM call.
        """
        sid = request.sid
        web_session = get_session(app, sid)
        if not web_session or hasattr(web_session, '_cached_summary'):
            return

        if web_session._llm_instance is None:
            web_session._cached_summary = NO_AI_SUMMARY
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

        # Use pre-fetched summary if available, otherwise generate now.
        # If the LLM was never initialised (e.g. noting with no AI
        # participants) skip the call entirely.
        if hasattr(web_session, '_cached_summary'):
            summary = web_session._cached_summary
        elif web_session._llm_instance is None:
            summary = NO_AI_SUMMARY
        else:
            summary = ""
            try:
                summary = asyncio.run(web_session.generate_summary())
            except Exception:
                summary = ""

        session_data = web_session.end()
        if summary:
            session_data["summary"] = summary
        if web_session.meditation_type != "exploration":
            session_data["meditation_type"] = web_session.meditation_type
        if getattr(web_session, "client_id", None):
            session_data["client_id"] = web_session.client_id
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

"""WebSocket event handlers for the Flask-SocketIO application."""

import asyncio
import logging
import time

import numpy as np
from flask import Flask, request
from flask_socketio import SocketIO, emit

from .meditation_session import WebMeditationSession, _migrate_style

logger = logging.getLogger(__name__)


def register_socketio_events(socketio: SocketIO, app: Flask) -> None:
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
        app.web_sessions[session_id] = web_session
        app.sid_to_session[sid] = session_id
        app.session_to_sid[session_id] = sid
        logger.info("New session %s… for sid=%s…", session_id[:12], sid[:8])

        # Send pacing config and TTS settings to the client
        emit("session_config", {
            "silence_base_ms": config.pacing.silence_base_ms,
            "silence_max_ms": config.pacing.silence_max_ms,
            "tts_rate": config.tts.rate,
        })

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
        except Exception as e:
            logger.error("Error in user_message handler: %s", e)
            emit("error", {"type": "llm", "message": "The facilitator had trouble responding. Trying a simpler reply."})
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
        if web_session.meditation_type != "exploration":
            session_data["meditation_type"] = web_session.meditation_type
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

    @socketio.on("voice_mute")
    def handle_voice_mute(data):
        sid = request.sid
        session_id = app.sid_to_session.get(sid)
        if not session_id or session_id not in app.web_sessions:
            return
        app.web_sessions[session_id].client_muted = data.get("muted", False)

    @socketio.on("check_resume_intent")
    def handle_check_resume_intent(data):
        """Classify whether a silence-mode utterance signals resume intent."""
        sid = request.sid
        web_session = _get_session(sid)
        if not web_session or not web_session.in_silence_mode:
            return
        text = data.get("text", "").strip()
        if not text:
            return
        try:
            is_resume = asyncio.run(web_session.classify_resume_intent(text))
        except Exception:
            is_resume = False
        if is_resume:
            emit("resume_detected", {})

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
        if voice:
            web_session = _get_session(request.sid)
            if web_session:
                web_session.tts_voice_name = voice

    @socketio.on("noting_user_note")
    def handle_noting_user_note(data):
        """Save a user's noting label to the session transcript."""
        web_session = _get_session(request.sid)
        if not web_session:
            return
        text = (data.get("text") or "").strip()
        if text:
            web_session.session.add_user_message(text, name=data.get("name"))

    @socketio.on("noting_turn")
    def handle_noting_turn(data):
        """Generate an LLM noting label for a circle participant."""
        sid = request.sid
        web_session = _get_session(sid)
        if not web_session:
            return

        context = data.get("context", [])
        reactive = data.get("reactive", "none")
        participant_index = data.get("participant_index", 0)
        voice = data.get("voice")

        try:
            label = asyncio.run(web_session.generate_noting_label(context, reactive))
        except Exception:
            label = "breathing"

        # Save to session transcript
        name = data.get("name")
        web_session.session.add_assistant_message(label, name=name)

        audio = None
        if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
            if voice:
                app.server_tts.set_voice(voice)
            audio = app.server_tts.speak_to_bytes(label)

        emit("noting_label", {
            "text": label,
            "audio": audio,
            "participant_index": participant_index,
        })

    @socketio.on("noting_tts")
    def handle_noting_tts(data):
        """Generate TTS audio for a fixed-phrase noting participant."""
        sid = request.sid
        web_session = _get_session(sid)
        if not web_session:
            return

        text = data.get("text", "").strip()
        voice = data.get("voice")
        participant_index = data.get("participant_index", 0)
        if not text:
            return

        # Save to session transcript
        web_session.session.add_assistant_message(text, name=data.get("name"))

        audio = None
        if web_session.tts_enabled and app.server_tts and hasattr(app.server_tts, 'speak_to_bytes'):
            if voice:
                app.server_tts.set_voice(voice)
            audio = app.server_tts.speak_to_bytes(text)

        emit("noting_audio", {
            "text": text,
            "audio": audio,
            "participant_index": participant_index,
        })

    @socketio.on("audio_data")
    def handle_audio_data(data):
        """Receive raw PCM float32 audio and transcribe with Whisper.

        Runs transcription in a background task so the event handler
        returns immediately — this keeps the socket alive during slow
        Whisper inference.
        """
        if not app.whisper_model_ready:
            emit("transcription", {"text": "", "error": "Whisper model still loading..."})
            return

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
            logger.debug("STT received %d samples @ %dHz (%.1fs)%s", len(audio), sample_rate, duration, label)
        except Exception as e:
            logger.error("STT error parsing audio: %s", e)
            emit("transcription", {"text": "", "error": str(e)})
            return

        # Look up session so we can emit to the right socket even after
        # a reconnection changes the sid.
        session_id = app.sid_to_session.get(request.sid)

        def _transcribe():
            try:
                if not app.whisper_lock.acquire(timeout=15):
                    logger.debug("Whisper busy, dropping audio")
                    target_sid = app.session_to_sid.get(session_id)
                    if target_sid:
                        socketio.emit("transcription", {"text": "", "error": "busy"}, to=target_sid)
                    return

                try:
                    t0 = time.time()
                    result = app.whisper_stt.transcribe(audio, sample_rate=sample_rate)
                    elapsed = time.time() - t0
                    text = result.text.strip()
                    logger.debug("Transcribed in %.1fs: \"%s\"", elapsed, text)
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
                    logger.debug("No active socket for session, dropping result")
            except Exception as e:
                logger.error("STT error: %s", e)
                target_sid = app.session_to_sid.get(session_id)
                if target_sid:
                    socketio.emit("transcription", {"text": "", "error": str(e)}, to=target_sid)

        socketio.start_background_task(_transcribe)

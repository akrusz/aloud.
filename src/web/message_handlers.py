"""Message and noting WebSocket event handlers.

Handles: user_message, check_resume_intent, noting_user_note, noting_turn, noting_tts.
"""

import asyncio
import logging
import re

from flask import Flask, request
from flask_socketio import SocketIO, emit

from .socketio_handlers import get_session, speak_to_audio

logger = logging.getLogger(__name__)


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences at natural boundaries.

    Returns a list of 1+ non-empty strings.  Keeps punctuation attached
    to the sentence that ends with it.
    """
    # Split on a single sentence-ending punctuation mark followed by whitespace
    # (avoids splitting on ellipses like "I see...")
    parts = re.split(r'(?<=[^.!?][.!?])\s+', text.strip())
    return [p for p in parts if p.strip()]


_CHUNK_ENGINES = ("PiperTTS",)


def _emit_chunked_audio(app, web_session, text: str) -> None:
    """Synthesize TTS in chunks for local neural engines, single pass otherwise.

    Only Piper benefits from chunking — its synthesis time scales with
    text length.  macOS/browser TTS is near-instant, and ElevenLabs has
    per-request network overhead that makes chunking worse.

    Emits ``facilitator_audio`` events with ``{"audio": ..., "final": bool}``.
    """
    # Only chunk for local neural TTS engines
    tts = app.server_tts
    engine_name = type(tts).__name__ if tts else ""
    if engine_name not in _CHUNK_ENGINES:
        audio = speak_to_audio(app, web_session, text)
        if audio:
            emit("facilitator_audio", {"audio": audio, "final": True})
        return

    sentences = _split_sentences(text)
    if not sentences:
        return

    # If first sentence is less than 1/8 of total length, don't bother
    # chunking — the pause would be noticeable for little gain.
    min_first_chunk = len(text) // 8
    if len(sentences) < 2 or len(sentences[0]) < min_first_chunk:
        audio = speak_to_audio(app, web_session, text)
        if audio:
            emit("facilitator_audio", {"audio": audio, "final": True})
        return

    # First chunk: first sentence — synthesize and emit immediately
    first = sentences[0]
    audio = speak_to_audio(app, web_session, first)
    if audio:
        emit("facilitator_audio", {"audio": audio, "final": False})

    # Remaining chunk: everything else
    rest = " ".join(sentences[1:])
    audio = speak_to_audio(app, web_session, rest)
    if audio:
        emit("facilitator_audio", {"audio": audio, "final": True})


def register_message_handlers(socketio: SocketIO, app: Flask) -> None:
    """Register message and noting event handlers."""

    @socketio.on("user_message")
    def handle_user_message(data):
        sid = request.sid
        web_session = get_session(app, sid)
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

        web_session.pacing.on_speech_end()
        emit("facilitator_typing", {"typing": True})

        try:
            response, hold_signal = asyncio.run(web_session.generate_response(text))
            # Emit text immediately so the user sees it while TTS synthesizes
            emit("facilitator_message", {"text": response, "type": "response"})
            # Chunked TTS: synthesize first sentence and emit immediately,
            # then synthesize the rest while the first chunk plays.
            _emit_chunked_audio(app, web_session, response)
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

    @socketio.on("check_resume_intent")
    def handle_check_resume_intent(data):
        """Classify whether a silence-mode utterance signals resume intent."""
        sid = request.sid
        web_session = get_session(app, sid)
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

    @socketio.on("noting_user_note")
    def handle_noting_user_note(data):
        """Save a user's noting label to the session transcript."""
        web_session = get_session(app, request.sid)
        if not web_session:
            return
        text = (data.get("text") or "").strip()
        if text:
            web_session.session.add_user_message(text, name=data.get("name"))

    @socketio.on("noting_turn")
    def handle_noting_turn(data):
        """Generate an LLM noting label for a circle participant."""
        sid = request.sid
        web_session = get_session(app, sid)
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

        effective_voice = voice or web_session.tts_voice_name
        audio = speak_to_audio(app, web_session, label, voice=effective_voice)

        emit("noting_label", {
            "text": label,
            "audio": audio,
            "participant_index": participant_index,
        })

    @socketio.on("noting_tts")
    def handle_noting_tts(data):
        """Generate TTS audio for a fixed-phrase noting participant."""
        sid = request.sid
        web_session = get_session(app, sid)
        if not web_session:
            return

        text = data.get("text", "").strip()
        voice = data.get("voice")
        participant_index = data.get("participant_index", 0)
        if not text:
            return

        # Save to session transcript
        web_session.session.add_assistant_message(text, name=data.get("name"))

        effective_voice = voice or web_session.tts_voice_name
        audio = speak_to_audio(app, web_session, text, voice=effective_voice)

        emit("noting_audio", {
            "text": text,
            "audio": audio,
            "participant_index": participant_index,
        })

"""Audio and TTS WebSocket event handlers.

Handles: audio_data, voice_mute, set_tts_rate, set_tts_voice.
"""

import logging
import time

import numpy as np
from flask import Flask, request
from flask_socketio import SocketIO, emit

from .socketio_handlers import get_session

logger = logging.getLogger(__name__)


def register_audio_handlers(socketio: SocketIO, app: Flask) -> None:
    """Register audio and TTS event handlers."""

    @socketio.on("voice_mute")
    def handle_voice_mute(data):
        sid = request.sid
        session_id = app.sid_to_session.get(sid)
        if not session_id or session_id not in app.web_sessions:
            return
        app.web_sessions[session_id].client_muted = data.get("muted", False)

    @socketio.on("set_tts_rate")
    def handle_set_tts_rate(data):
        rate = data.get("rate")
        if rate and isinstance(rate, (int, float)) and app.server_tts:
            rate = max(60, min(240, int(rate)))
            app.server_tts.set_rate(rate)

    @socketio.on("set_tts_voice")
    def handle_set_tts_voice(data):
        voice = data.get("voice")
        if voice:
            # Validate for Piper: only accept downloaded voices
            from ..tts.piper import PiperTTS
            tts = app.server_tts
            if isinstance(tts, PiperTTS) and not PiperTTS.is_model_downloaded(voice):
                logger.debug("Rejecting undownloaded Piper voice: %s", voice)
                return
            web_session = get_session(app, request.sid)
            if web_session:
                web_session.tts_voice_name = voice

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

"""STT routes for the TS browser/Capacitor UI.

Accepts raw 16 kHz Float32 mono PCM in the request body and returns
the transcription. Body is the audio buffer with no envelope — same
on-the-wire shape the existing socketio `audio_data` handler already
expects, just delivered via a plain POST so the TS client can use
`fetch` instead of socket.io.

This is the desktop / Firefox / Safari STT path. iOS/Android Capacitor
use the native plugin (no Whisper). The web preview's stt-picker falls
back to this when the Web Speech API isn't available.
"""

import logging

import numpy as np
from flask import Flask, jsonify, request

logger = logging.getLogger(__name__)

# 30 seconds of 16 kHz float32 mono ≈ 1.9 MB. Cap conservatively at 5 MB
# so a runaway recorder can't OOM the worker.
MAX_AUDIO_BYTES = 5 * 1024 * 1024


def register_stt_routes(app: Flask) -> None:
    """Register HTTP STT routes on the Flask app."""

    @app.route("/api/stt/whisper", methods=["POST"])
    def stt_whisper():
        if not getattr(app, "whisper_model_ready", False):
            return jsonify({"error": "Whisper model still loading — try again in a moment."}), 503

        body = request.get_data(cache=False)
        if not body:
            return jsonify({"error": "Empty request body."}), 400
        if len(body) > MAX_AUDIO_BYTES:
            return jsonify({"error": "Audio payload too large."}), 413
        if len(body) % 4 != 0:
            return jsonify({"error": "Body length not aligned to float32 frames."}), 400

        audio = np.frombuffer(body, dtype=np.float32)
        if audio.size == 0:
            return jsonify({"text": ""})

        sample_rate = int(request.args.get("sample_rate", "16000"))

        with app.whisper_lock:
            try:
                result = app.whisper_stt.transcribe(audio, sample_rate=sample_rate)
            except Exception as e:
                logger.exception("Whisper transcription failed")
                return jsonify({"error": f"Transcription failed: {e}"}), 500

        return jsonify({
            "text": (result.text or "").strip(),
            "language": result.language,
            "duration": result.duration,
        })

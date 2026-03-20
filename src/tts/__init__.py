"""Text-to-speech engines."""

import logging
import sys

from .base import TTSEngine
from .piper import PiperTTS
from .parakeet import ParakeetTTS
from .elevenlabs import ElevenLabsTTS

logger = logging.getLogger(__name__)

__all__ = [
    "TTSEngine",
    "PiperTTS",
    "ParakeetTTS",
    "ElevenLabsTTS",
    "create_tts",
]

# Only import MacOSTTS on macOS
if sys.platform == "darwin":
    from .macos import MacOSTTS
    __all__.append("MacOSTTS")


def create_tts(
    engine: str = "macos",
    voice: str | None = None,
    rate: int = 180,
    **kwargs,
) -> "MacOSTTS | PiperTTS | ParakeetTTS | ElevenLabsTTS | None":
    """Factory function to create TTS engine.

    Args:
        engine: TTS engine name:
            - "macos": macOS native 'say' command (zero latency, decent quality)
            - "piper": Piper TTS (fast local neural TTS)
            - "parakeet": NVIDIA Parakeet (high quality neural TTS)
            - "elevenlabs": ElevenLabs API (highest quality, requires API key)
            - "browser": no server-side TTS; browser speechSynthesis only
        voice: Voice name/model (engine-specific)
        rate: Speaking rate in WPM (mainly for macos)
        **kwargs: Additional engine-specific arguments

    Returns:
        TTS engine instance, or None for browser-only mode
    """
    if engine == "macos":
        if sys.platform != "darwin":
            logger.warning("'macos' TTS engine is only available on macOS. Falling back to browser TTS.")
            return None
        from .macos import MacOSTTS
        return MacOSTTS(
            voice=voice or "Samantha",
            rate=rate,
        )

    elif engine == "piper":
        return PiperTTS(
            voice=voice or "en_US-lessac-medium",
            rate=float(rate) / 180.0,  # Convert WPM to rate multiplier
            model_path=kwargs.get("model_path"),
        )

    elif engine == "parakeet":
        return ParakeetTTS(
            model_name=kwargs.get("model_name", "nvidia/parakeet-tts-1.1b"),
            device=kwargs.get("device", "auto"),
            backend=kwargs.get("backend", "transformers"),
        )

    elif engine == "elevenlabs":
        return ElevenLabsTTS(
            api_key=kwargs.get("api_key"),
            voice_name=voice,
            voice_id=kwargs.get("voice_id"),
            model_id=kwargs.get("model_id", "eleven_v3"),
            stability=kwargs.get("stability", 0.75),
            similarity_boost=kwargs.get("similarity_boost", 0.75),
        )

    elif engine == "browser":
        # No server-side TTS — browser speechSynthesis handles everything.
        # Return None so app.py falls back gracefully.
        return None

    else:
        raise ValueError(
            f"Unknown TTS engine: {engine}. "
            f"Available: macos, piper, parakeet, elevenlabs, browser"
        )

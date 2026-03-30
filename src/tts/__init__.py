"""Text-to-speech engines."""

import logging
import re
import sys

from .base import TTSEngine
from .piper import PiperTTS
from .elevenlabs import ElevenLabsTTS

logger = logging.getLogger(__name__)

__all__ = [
    "TTSEngine",
    "PiperTTS",
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
) -> "MacOSTTS | PiperTTS | ElevenLabsTTS | None":
    """Factory function to create TTS engine.

    Args:
        engine: TTS engine name:
            - "macos": macOS native 'say' command (zero latency, decent quality)
            - "piper": Piper TTS (fast local neural TTS)
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
        if not PiperTTS.is_available():
            logger.warning("Piper TTS not available (piper module not installed). Falling back to browser TTS.")
            return None
        return PiperTTS(
            voice=voice or "en_US-lessac-medium",
            rate=rate,
            model_path=kwargs.get("model_path"),
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
            f"Available: macos, piper, elevenlabs, browser"
        )


def engine_for_voice(voice_name: str) -> str | None:
    """Determine which TTS engine should handle a given voice name.

    Checks the Piper voice catalogue, then falls back to macOS on Darwin.
    ElevenLabs voices are dynamic (API-driven) and cannot be detected by
    name alone.
    """
    from .piper import PIPER_VOICES
    if any(v["name"] == voice_name for v in PIPER_VOICES):
        return "piper"

    if sys.platform == "darwin":
        return "macos"

    return None


def aggregate_voices(server_tts=None) -> list[dict]:
    """Collect voices from all available TTS engines.

    Returns a merged list with each voice tagged with an ``engine`` key.
    Local engines (macOS, Piper) are always included when available.
    ElevenLabs is included only when *server_tts* is an active ElevenLabs
    instance (requires an API key).

    macOS Premium voices are marked as recommended so they appear in the
    top section of the voice picker.
    """
    all_voices: list[dict] = []
    seen: set[str] = set()

    # Piper voices (if installed)
    if PiperTTS.is_available():
        try:
            piper = PiperTTS()
            for v in piper.list_voices():
                v["engine"] = "piper"
                all_voices.append(v)
                seen.add(v["name"])
        except Exception:
            pass

    # macOS system voices (always available on macOS)
    if sys.platform == "darwin":
        from .macos import MacOSTTS
        try:
            for v in MacOSTTS.list_voices():
                if v["name"] not in seen:
                    v["engine"] = "macos"
                    # Mark Premium voices as recommended
                    if re.search(r"Premium", v["name"], re.IGNORECASE):
                        v["recommended"] = True
                    all_voices.append(v)
                    seen.add(v["name"])
        except Exception:
            pass

    # ElevenLabs — only when it's the active engine (needs API key)
    if isinstance(server_tts, ElevenLabsTTS):
        try:
            for v in server_tts.list_voices():
                name = v.get("name", "")
                if name and name not in seen:
                    v["engine"] = "elevenlabs"
                    all_voices.append(v)
                    seen.add(name)
        except Exception:
            pass

    return all_voices

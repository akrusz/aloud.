"""Piper text-to-speech engine.

Piper is a fast, local neural TTS system.  Uses the piper library directly
(no subprocess) so it works in frozen PyInstaller bundles and pywebview.
https://github.com/rhasspy/piper
"""

from __future__ import annotations

import asyncio
import io
import logging
import tempfile
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


# Popular Piper voice models — used by list_voices() so users see real choices.
# Recommended voices are shown first in the voice picker.
#
# Multi-speaker voices use "model" + "speaker" fields.  All speakers share
# a single download; is_model_downloaded / _voice_hf_urls resolve via the
# model name.  The "name" is what appears in the voice picker.
PIPER_VOICES = [
    # Recommended — curated libritts-high speakers (one 105 MB download for all)
    {"name": "Libritts p3922 (F)", "lang": "en_US", "size_mb": 105, "recommended": True,
     "model": "en_US-libritts-high", "speaker": "p3922"},
    {"name": "Libritts p4356 (F)", "lang": "en_US", "size_mb": 105, "recommended": True,
     "model": "en_US-libritts-high", "speaker": "p4356"},
    {"name": "Libritts p3368 (M)", "lang": "en_US", "size_mb": 105, "recommended": True,
     "model": "en_US-libritts-high", "speaker": "p3368"},
    {"name": "Libritts p2053 (M)", "lang": "en_US", "size_mb": 105, "recommended": True,
     "model": "en_US-libritts-high", "speaker": "p2053"},
    # Other voices
    {"name": "en_US-joe-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-kristin-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-norman-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-lessac-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-lessac-high", "lang": "en_US", "size_mb": 105},
    {"name": "en_US-amy-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-arctic-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-ryan-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-ryan-high", "lang": "en_US", "size_mb": 105},
    {"name": "en_GB-alan-medium", "lang": "en_GB", "size_mb": 63},
    {"name": "en_GB-cori-medium", "lang": "en_GB", "size_mb": 63},
    {"name": "en_GB-jenny_dioco-medium", "lang": "en_GB", "size_mb": 63},
]


def _get_piper_models_dir() -> Path:
    """Return our managed piper models directory."""
    from ..config import get_user_config_dir
    return get_user_config_dir() / "piper-models"


def _resolve_voice(voice_name: str) -> tuple[str, str | None]:
    """Resolve a voice name to (model_name, speaker_key).

    Multi-speaker voices in PIPER_VOICES have a ``model`` field pointing
    to the shared .onnx file and a ``speaker`` field for the speaker key
    in the model's speaker_id_map.  Single-speaker voices just return
    (voice_name, None).
    """
    for v in PIPER_VOICES:
        if v["name"] == voice_name and "model" in v:
            return v["model"], v.get("speaker")
    return voice_name, None


def _voice_hf_urls(voice_name: str) -> list[tuple[str, str]]:
    """Return [(url, filename), ...] for a piper voice's model files."""
    # Resolve multi-speaker display names to the actual model name
    model_name, _ = _resolve_voice(voice_name)
    parts = model_name.split("-")
    locale = parts[0]       # en_US
    quality = parts[-1]     # medium
    speaker = "-".join(parts[1:-1])  # lessac, jenny_dioco, etc.
    # Underscores in speaker names need to stay as-is in the path
    lang = locale.split("_")[0]
    base = f"https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{lang}/{locale}/{speaker}/{quality}"
    return [
        (f"{base}/{model_name}.onnx", f"{model_name}.onnx"),
        (f"{base}/{model_name}.onnx.json", f"{model_name}.onnx.json"),
    ]


class PiperTTS:
    """Text-to-speech using Piper.

    Piper provides high-quality local TTS with various voice models.
    Runs well on Apple Silicon.
    """

    def __init__(
        self,
        model_path: str | None = None,
        voice: str = "en_US-lessac-medium",
        rate: int = 180,
    ):
        """Initialize Piper TTS.

        Args:
            model_path: Path to Piper model (.onnx file), or None to download
            voice: Voice model name if model_path not specified
            rate: Speaking rate in WPM (180 = normal)
        """
        self.model_path = model_path
        self.voice = voice
        self.rate = rate
        self._speaking = False
        self._piper_voice = None      # cached PiperVoice instance
        self._loaded_model_path = None  # path of the cached model
        # Resolve multi-speaker voice → model + speaker
        self._model_name, self._speaker = _resolve_voice(voice)

    def _get_model_path(self) -> str | None:
        """Resolve the model path for the current voice."""
        if self.model_path:
            return self.model_path
        local_path = _get_piper_models_dir() / f"{self._model_name}.onnx"
        return str(local_path) if local_path.exists() else None

    def _load_voice(self):
        """Load (or reuse cached) PiperVoice for the current model."""
        model_path = self._get_model_path()
        if model_path is None:
            return None
        # Reuse if same model is already loaded
        if self._piper_voice and self._loaded_model_path == model_path:
            return self._piper_voice
        try:
            from piper.voice import PiperVoice
            import piper as _piper_pkg
            # Resolve espeak-ng-data relative to the piper package (works in
            # frozen PyInstaller builds where the default venv path doesn't exist)
            espeak_dir = Path(_piper_pkg.__file__).parent / "espeak-ng-data"
            self._piper_voice = PiperVoice.load(
                model_path, espeak_data_dir=str(espeak_dir))
            self._loaded_model_path = model_path
            return self._piper_voice
        except Exception as e:
            logger.error("Failed to load Piper model %s: %s", model_path, e)
            return None

    def _length_scale(self) -> float:
        """Convert WPM rate to Piper length_scale (inverse relationship).

        Piper's native pace at length_scale 1.0 is roughly 220 WPM.
        """
        return 220.0 / max(self.rate, 1)

    def _get_speaker_id(self) -> int | None:
        """Look up the numeric speaker_id from the model's JSON config."""
        if not self._speaker:
            return None
        config_path = _get_piper_models_dir() / f"{self._model_name}.onnx.json"
        if not config_path.exists():
            return None
        import json
        config = json.loads(config_path.read_text())
        return config.get("speaker_id_map", {}).get(self._speaker)

    def _synthesize_wav_bytes(self, text: str) -> bytes | None:
        """Synthesize text to WAV bytes using the piper library."""
        pv = self._load_voice()
        if pv is None:
            return None
        try:
            from piper.config import SynthesisConfig
            syn_config = SynthesisConfig(
                speaker_id=self._get_speaker_id(),
                length_scale=self._length_scale(),
            )
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav_file:
                pv.synthesize_wav(text, wav_file, syn_config=syn_config)
            return buf.getvalue() or None
        except Exception as e:
            logger.error("Piper synthesis error: %s", e)
            return None

    async def speak(self, text: str) -> None:
        """Speak the given text."""
        self.stop()
        if not text.strip():
            return

        self._speaking = True
        try:
            wav_bytes = await asyncio.get_event_loop().run_in_executor(
                None, self._synthesize_wav_bytes, text,
            )
            if not wav_bytes:
                return

            # Write to temp file and play
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.write(wav_bytes)
            tmp.close()
            try:
                from ..audio.playback import play_audio_file
                await play_audio_file(tmp.name)
            finally:
                Path(tmp.name).unlink(missing_ok=True)
        finally:
            self._speaking = False

    def speak_to_bytes(self, text: str) -> bytes | None:
        """Generate speech as WAV bytes (synchronous, blocking)."""
        if not text.strip():
            return None
        return self._synthesize_wav_bytes(text)

    def stop(self) -> None:
        """Stop any current speech."""
        from ..audio.playback import stop_playback

        stop_playback()
        self._speaking = False

    def is_speaking(self) -> bool:
        """Check if currently speaking.

        Returns:
            True if currently speaking
        """
        return self._speaking

    @staticmethod
    def is_available() -> bool:
        """Check if the piper module is installed."""
        try:
            import piper  # noqa: F401
            return True
        except ImportError:
            return False

    @staticmethod
    def is_model_downloaded(voice: str) -> bool:
        """Check if a voice model is already downloaded."""
        model_name, _ = _resolve_voice(voice)
        model_path = _get_piper_models_dir() / f"{model_name}.onnx"
        return model_path.exists()

    @staticmethod
    def get_model_path(voice: str) -> str:
        """Return the full path to a downloaded model."""
        model_name, _ = _resolve_voice(voice)
        return str(_get_piper_models_dir() / f"{model_name}.onnx")

    def list_voices(self) -> list[dict]:
        """List available Piper voice models (empty if piper not installed)."""
        if not self.is_available():
            return []
        voices = []
        for v in PIPER_VOICES:
            entry = {
                "name": v["name"],
                "lang": v["lang"],
                "downloaded": self.is_model_downloaded(v["name"]),
                "size_display": str(v["size_mb"]) + " MB",
                "needs_download": True,
                # Shared .onnx basename (== name for single-speaker voices), so
                # the picker can group speakers that download together.
                "model": v.get("model", v["name"]),
            }
            if v.get("recommended"):
                entry["recommended"] = True
            voices.append(entry)
        return voices

    def set_voice(self, voice: str) -> None:
        """Set the voice/model to use.

        Args:
            voice: Voice name (may be a multi-speaker display name)
        """
        self.voice = voice
        self._model_name, self._speaker = _resolve_voice(voice)

    def set_rate(self, rate: float) -> None:
        """Set the speaking rate.

        Args:
            rate: Rate multiplier (1.0 = normal)
        """
        self.rate = rate

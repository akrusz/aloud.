"""Piper text-to-speech engine.

Piper is a fast, local neural TTS system.
https://github.com/rhasspy/piper
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .macos import MacOSTTS


# Popular Piper voice models — used by list_voices() so users see real choices
PIPER_VOICES = [
    {"name": "en_US-lessac-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-lessac-high", "lang": "en_US", "size_mb": 105},
    {"name": "en_US-amy-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-arctic-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-ryan-medium", "lang": "en_US", "size_mb": 63},
    {"name": "en_US-ryan-high", "lang": "en_US", "size_mb": 105},
    {"name": "en_US-libritts-high", "lang": "en_US", "size_mb": 105},
    {"name": "en_GB-alan-medium", "lang": "en_GB", "size_mb": 63},
    {"name": "en_GB-cori-medium", "lang": "en_GB", "size_mb": 63},
    {"name": "en_GB-jenny_dioco-medium", "lang": "en_GB", "size_mb": 63},
]


def _get_piper_models_dir() -> Path:
    """Return our managed piper models directory."""
    from ..config import get_user_config_dir
    return get_user_config_dir() / "piper-models"


def _voice_hf_urls(voice_name: str) -> list[tuple[str, str]]:
    """Return [(url, filename), ...] for a piper voice's model files."""
    parts = voice_name.split("-")
    locale = parts[0]       # en_US
    quality = parts[-1]     # medium
    speaker = "-".join(parts[1:-1])  # lessac, jenny_dioco, etc.
    # Underscores in speaker names need to stay as-is in the path
    lang = locale.split("_")[0]
    base = f"https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{lang}/{locale}/{speaker}/{quality}"
    return [
        (f"{base}/{voice_name}.onnx", f"{voice_name}.onnx"),
        (f"{base}/{voice_name}.onnx.json", f"{voice_name}.onnx.json"),
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
        rate: float = 1.0,
    ):
        """Initialize Piper TTS.

        Args:
            model_path: Path to Piper model (.onnx file), or None to download
            voice: Voice model name if model_path not specified
            rate: Speaking rate multiplier (1.0 = normal)
        """
        self.model_path = model_path
        self.voice = voice
        self.rate = rate
        self._speaking = False

    async def speak(self, text: str) -> None:
        """Speak the given text.

        Args:
            text: Text to speak
        """
        self.stop()

        if not text.strip():
            return

        self._speaking = True
        try:
            # Create temp file for audio output
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                output_path = f.name

            # Build piper command
            cmd = ["piper"]

            if self.model_path:
                cmd.extend(["--model", self.model_path])
            else:
                local_path = _get_piper_models_dir() / f"{self.voice}.onnx"
                if local_path.exists():
                    cmd.extend(["--model", str(local_path)])
                else:
                    # Model not downloaded — skip silently (falls back to browser TTS)
                    return

            cmd.extend([
                "--output_file", output_path,
                "--length_scale", str(1.0 / self.rate),
            ])

            # Run piper to generate audio
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(input=text.encode())

            # Play the audio
            if Path(output_path).exists():
                from ..audio.playback import play_audio_file

                await play_audio_file(output_path)

                # Clean up
                Path(output_path).unlink(missing_ok=True)

        finally:
            self._speaking = False

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
        """Check if the piper binary is installed."""
        return shutil.which("piper") is not None

    @staticmethod
    def is_model_downloaded(voice: str) -> bool:
        """Check if a voice model is already downloaded."""
        model_path = _get_piper_models_dir() / f"{voice}.onnx"
        return model_path.exists()

    @staticmethod
    def get_model_path(voice: str) -> str:
        """Return the full path to a downloaded model."""
        return str(_get_piper_models_dir() / f"{voice}.onnx")

    def list_voices(self) -> list[dict]:
        """List available Piper voice models (empty if piper not installed)."""
        if not self.is_available():
            return []
        return [
            {
                "name": v["name"],
                "lang": v["lang"],
                "downloaded": self.is_model_downloaded(v["name"]),
                "size_display": str(v["size_mb"]) + " MB",
                "needs_download": True,
            }
            for v in PIPER_VOICES
        ]

    def set_voice(self, voice: str) -> None:
        """Set the voice/model to use.

        Args:
            voice: Voice model name
        """
        self.voice = voice

    def set_rate(self, rate: float) -> None:
        """Set the speaking rate.

        Args:
            rate: Rate multiplier (1.0 = normal)
        """
        self.rate = rate


def create_tts(
    engine: str = "macos",
    voice: str = "Samantha",
    rate: int = 180,
) -> "MacOSTTS | PiperTTS":
    """Factory function to create TTS engine.

    Args:
        engine: TTS engine ("macos" or "piper")
        voice: Voice name/model
        rate: Speaking rate

    Returns:
        TTS engine instance
    """
    from .macos import MacOSTTS

    if engine == "macos":
        return MacOSTTS(voice=voice, rate=rate)
    elif engine == "piper":
        return PiperTTS(voice=voice, rate=float(rate) / 180.0)
    else:
        raise ValueError(f"Unknown TTS engine: {engine}")

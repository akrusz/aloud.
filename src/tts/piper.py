"""Piper text-to-speech engine.

Piper is a fast, local neural TTS system.
https://github.com/rhasspy/piper
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .macos import MacOSTTS


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
                cmd.extend(["--model", self.voice])

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

"""Base classes for text-to-speech engines."""

from dataclasses import dataclass
from typing import Protocol


@dataclass
class TTSConfig:
    """Configuration for TTS engine."""

    voice: str = "default"
    rate: int = 180  # words per minute
    volume: float = 1.0


class TTSEngine(Protocol):
    """Protocol for text-to-speech engines."""

    async def speak(self, text: str) -> None:
        """Speak the given text.

        Args:
            text: Text to speak
        """
        ...

    def stop(self) -> None:
        """Stop any current speech."""
        ...

    def is_speaking(self) -> bool:
        """Check if currently speaking.

        Returns:
            True if currently speaking
        """
        ...

    def set_voice(self, voice: str) -> None:
        """Set the voice to use.

        Args:
            voice: Voice identifier
        """
        ...

    def set_rate(self, rate: int) -> None:
        """Set the speaking rate.

        Args:
            rate: Words per minute
        """
        ...

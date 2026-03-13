"""Audio output / speaker playback."""

import asyncio
import logging
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SpeechRequest:
    """A request to speak text."""

    text: str
    voice: str | None = None
    rate: int | None = None  # words per minute


class AudioOutput(ABC):
    """Abstract base class for audio output."""

    @abstractmethod
    async def speak(self, request: SpeechRequest) -> None:
        """Speak the given text."""
        pass

    @abstractmethod
    def stop(self) -> None:
        """Stop any current speech."""
        pass

    @abstractmethod
    def is_speaking(self) -> bool:
        """Check if currently speaking."""
        pass


class MacOSAudioOutput(AudioOutput):
    """Audio output using macOS 'say' command."""

    def __init__(self, default_voice: str = "Samantha", default_rate: int = 180):
        self.default_voice = default_voice
        self.default_rate = default_rate
        self._process: subprocess.Popen | None = None
        self._speaking = False

    async def speak(self, request: SpeechRequest) -> None:
        """Speak text using macOS say command."""
        voice = request.voice or self.default_voice
        rate = request.rate or self.default_rate

        # Stop any current speech
        self.stop()

        self._speaking = True
        try:
            # Build command
            cmd = ["say", "-v", voice, "-r", str(rate), request.text]

            # Run asynchronously
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await self._process.wait()
        finally:
            self._speaking = False
            self._process = None

    def stop(self) -> None:
        """Stop current speech."""
        if self._process:
            self._process.terminate()
            self._process = None
        self._speaking = False

    def is_speaking(self) -> bool:
        """Check if currently speaking."""
        return self._speaking


class DummyAudioOutput(AudioOutput):
    """Dummy audio output for testing (prints to console)."""

    def __init__(self):
        self._speaking = False

    async def speak(self, request: SpeechRequest) -> None:
        """Print text to console instead of speaking."""
        self._speaking = True
        print(f"\n🔊 Facilitator: {request.text}")
        # Simulate speaking time (roughly 150 words per minute)
        words = len(request.text.split())
        await asyncio.sleep(words / 2.5)  # ~150 wpm
        self._speaking = False

    def stop(self) -> None:
        self._speaking = False

    def is_speaking(self) -> bool:
        return self._speaking


def create_audio_output(
    engine: str = "macos",
    voice: str = "Samantha",
    rate: int = 180,
) -> AudioOutput:
    """Factory function to create appropriate audio output."""
    if engine == "macos":
        return MacOSAudioOutput(default_voice=voice, default_rate=rate)
    elif engine == "dummy":
        return DummyAudioOutput()
    else:
        raise ValueError(f"Unknown TTS engine: {engine}")

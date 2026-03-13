"""Base classes for speech-to-text engines."""

from dataclasses import dataclass
from typing import Protocol

import numpy as np


@dataclass
class TranscriptionResult:
    """Result from speech-to-text transcription."""

    text: str
    language: str | None = None
    confidence: float | None = None
    duration: float | None = None  # Duration of audio in seconds


class STTEngine(Protocol):
    """Protocol for speech-to-text engines."""

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000) -> TranscriptionResult:
        """Transcribe audio to text.

        Args:
            audio: Audio data as numpy array (int16 or float32)
            sample_rate: Sample rate of the audio

        Returns:
            TranscriptionResult with transcribed text
        """
        ...

    def transcribe_file(self, path: str) -> TranscriptionResult:
        """Transcribe audio from a file.

        Args:
            path: Path to audio file

        Returns:
            TranscriptionResult with transcribed text
        """
        ...

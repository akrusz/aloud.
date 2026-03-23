"""Speech-to-text engines."""

from .base import STTEngine, TranscriptionResult
from .whisper import WhisperSTT
from .whisper_cpp import WhisperCppSTT

__all__ = ["STTEngine", "TranscriptionResult", "WhisperSTT", "WhisperCppSTT"]

"""Audio input/output and voice activity detection."""

from .vad import VoiceActivityDetector


def __getattr__(name):
    if name == "AudioInput":
        from .input import AudioInput
        return AudioInput
    if name == "AudioOutput":
        from .output import AudioOutput
        return AudioOutput
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["AudioInput", "AudioOutput", "VoiceActivityDetector"]

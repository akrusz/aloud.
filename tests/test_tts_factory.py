"""Tests for the TTS factory function."""

import sys

import pytest

from src.tts import create_tts
from src.tts.piper import PiperTTS
from src.tts.elevenlabs import ElevenLabsTTS


class TestCreateTTS:
    def test_create_macos(self):
        if sys.platform != "darwin":
            pytest.skip("macOS only")
        from src.tts.macos import MacOSTTS
        tts = create_tts("macos")
        assert isinstance(tts, MacOSTTS)

    def test_create_macos_returns_none_on_non_darwin(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "linux")
        result = create_tts("macos")
        assert result is None

    def test_create_piper(self):
        tts = create_tts("piper")
        assert isinstance(tts, PiperTTS)

    def test_create_elevenlabs(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key-123")
        tts = create_tts("elevenlabs")
        assert isinstance(tts, ElevenLabsTTS)

    def test_create_elevenlabs_without_key_raises(self, monkeypatch):
        monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
        with pytest.raises(ValueError, match="API key required"):
            create_tts("elevenlabs")

    def test_create_browser_returns_none(self):
        result = create_tts("browser")
        assert result is None

    def test_create_unknown_raises(self):
        with pytest.raises(ValueError, match="Unknown TTS engine"):
            create_tts("unknown")


class TestCreateTTSOptions:
    def test_piper_voice_passed_through(self):
        tts = create_tts("piper", voice="en_GB-alan-medium")
        assert isinstance(tts, PiperTTS)
        assert tts.voice == "en_GB-alan-medium"

    def test_piper_rate_stored_as_wpm(self):
        tts = create_tts("piper", rate=360)
        assert isinstance(tts, PiperTTS)
        assert tts.rate == 360  # Stored as WPM, converted at synthesis time

"""Tests for Piper TTS engine utilities."""

import shutil

from src.tts.piper import PiperTTS, _voice_hf_urls


class TestVoiceHfUrls:
    def test_simple_speaker_name(self):
        urls = _voice_hf_urls("en_US-lessac-medium")
        assert len(urls) == 2
        base = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"
        assert urls[0] == (f"{base}/en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx")
        assert urls[1] == (f"{base}/en_US-lessac-medium.onnx.json", "en_US-lessac-medium.onnx.json")

    def test_underscore_speaker_name(self):
        urls = _voice_hf_urls("en_GB-jenny_dioco-medium")
        base = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium"
        assert urls[0] == (f"{base}/en_GB-jenny_dioco-medium.onnx", "en_GB-jenny_dioco-medium.onnx")
        assert urls[1] == (f"{base}/en_GB-jenny_dioco-medium.onnx.json", "en_GB-jenny_dioco-medium.onnx.json")

    def test_high_quality_voice(self):
        urls = _voice_hf_urls("en_US-ryan-high")
        base = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high"
        assert urls[0][0] == f"{base}/en_US-ryan-high.onnx"
        assert urls[1][0] == f"{base}/en_US-ryan-high.onnx.json"

    def test_returns_onnx_and_json_filenames(self):
        urls = _voice_hf_urls("en_US-lessac-medium")
        filenames = [url[1] for url in urls]
        assert filenames == ["en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"]


class TestIsModelDownloaded:
    def test_returns_true_when_model_exists(self, tmp_path, monkeypatch):
        monkeypatch.setattr("src.tts.piper._get_piper_models_dir", lambda: tmp_path)
        (tmp_path / "en_US-lessac-medium.onnx").write_text("fake model")
        assert PiperTTS.is_model_downloaded("en_US-lessac-medium") is True

    def test_returns_false_when_model_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr("src.tts.piper._get_piper_models_dir", lambda: tmp_path)
        assert PiperTTS.is_model_downloaded("en_US-lessac-medium") is False


class TestGetModelPath:
    def test_returns_correct_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("src.tts.piper._get_piper_models_dir", lambda: tmp_path)
        expected = str(tmp_path / "en_US-ryan-high.onnx")
        assert PiperTTS.get_model_path("en_US-ryan-high") == expected


class TestIsAvailable:
    def test_available_when_piper_installed(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", lambda name: "/usr/local/bin/piper")
        assert PiperTTS.is_available() is True

    def test_unavailable_when_piper_missing(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", lambda name: None)
        assert PiperTTS.is_available() is False


class TestListVoices:
    def test_returns_voices_when_available(self, tmp_path, monkeypatch):
        monkeypatch.setattr(shutil, "which", lambda name: "/usr/local/bin/piper")
        monkeypatch.setattr("src.tts.piper._get_piper_models_dir", lambda: tmp_path)
        # Pre-download one model
        (tmp_path / "en_US-lessac-medium.onnx").write_text("fake")

        tts = PiperTTS()
        voices = tts.list_voices()

        assert len(voices) > 0
        # Check dict keys on every voice
        required_keys = {"name", "lang", "downloaded", "size_display", "needs_download"}
        for v in voices:
            assert set(v.keys()) == required_keys

        # The pre-downloaded model should be marked as downloaded
        lessac = next(v for v in voices if v["name"] == "en_US-lessac-medium")
        assert lessac["downloaded"] is True
        assert lessac["needs_download"] is True
        assert lessac["lang"] == "en_US"
        assert "MB" in lessac["size_display"]

        # A model we didn't download should be False
        ryan = next(v for v in voices if v["name"] == "en_US-ryan-high")
        assert ryan["downloaded"] is False

    def test_returns_empty_when_piper_not_installed(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", lambda name: None)
        tts = PiperTTS()
        assert tts.list_voices() == []

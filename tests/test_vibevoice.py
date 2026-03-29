"""Tests for VibeVoice TTS engine utilities."""

import sys

from src.tts.vibevoice import VibeVoiceTTS


class TestIsAvailable:
    def test_available_when_deps_installed(self, monkeypatch):
        import types
        fake_vibevoice = types.ModuleType("vibevoice")
        fake_torch = types.ModuleType("torch")
        monkeypatch.setitem(sys.modules, "vibevoice", fake_vibevoice)
        monkeypatch.setitem(sys.modules, "torch", fake_torch)
        assert VibeVoiceTTS.is_available() is True

    def test_unavailable_when_deps_missing(self, monkeypatch):
        monkeypatch.delitem(sys.modules, "vibevoice", raising=False)
        monkeypatch.delitem(sys.modules, "torch", raising=False)

        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name in ("vibevoice", "torch"):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)
        assert VibeVoiceTTS.is_available() is False


class TestIsModelDownloaded:
    def test_filesystem_fallback_with_safetensors(self, tmp_path, monkeypatch):
        """When huggingface_hub is not available, falls back to filesystem check."""
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name == "huggingface_hub":
                raise ImportError("No module named 'huggingface_hub'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)

        model_dir = tmp_path / "hub" / "models--microsoft--VibeVoice-Realtime-0.5B"
        model_dir.mkdir(parents=True)
        (model_dir / "snapshots" / "abc123").mkdir(parents=True)
        (model_dir / "snapshots" / "abc123" / "model.safetensors").write_text("fake")

        monkeypatch.setenv("HF_HOME", str(tmp_path))
        assert VibeVoiceTTS.is_model_downloaded("microsoft/VibeVoice-Realtime-0.5B") is True

    def test_filesystem_fallback_without_safetensors(self, tmp_path, monkeypatch):
        """When HF cache exists but no safetensors files, returns False."""
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name == "huggingface_hub":
                raise ImportError("No module named 'huggingface_hub'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)

        model_dir = tmp_path / "hub" / "models--microsoft--VibeVoice-Realtime-0.5B"
        model_dir.mkdir(parents=True)

        monkeypatch.setenv("HF_HOME", str(tmp_path))
        assert VibeVoiceTTS.is_model_downloaded("microsoft/VibeVoice-Realtime-0.5B") is False

    def test_filesystem_fallback_no_cache_dir(self, tmp_path, monkeypatch):
        """When HF cache dir doesn't exist at all, returns False."""
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name == "huggingface_hub":
                raise ImportError("No module named 'huggingface_hub'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)
        monkeypatch.setenv("HF_HOME", str(tmp_path))
        assert VibeVoiceTTS.is_model_downloaded("microsoft/VibeVoice-Realtime-0.5B") is False


class TestListVoices:
    def test_returns_voices_when_available(self, monkeypatch):
        import types
        monkeypatch.setitem(sys.modules, "vibevoice", types.ModuleType("vibevoice"))
        monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))

        monkeypatch.setattr(VibeVoiceTTS, "is_model_downloaded", staticmethod(lambda *a, **kw: False))

        tts = VibeVoiceTTS()
        voices = tts.list_voices()

        assert len(voices) == 6
        names = {v["name"] for v in voices}
        assert "Emma" in names
        assert "Carter" in names
        for v in voices:
            assert v["lang"] == "en_US"
            assert v["downloaded"] is False
            assert v["needs_download"] is True

    def test_returns_empty_when_unavailable(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name in ("vibevoice", "torch"):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)
        monkeypatch.delitem(sys.modules, "vibevoice", raising=False)
        monkeypatch.delitem(sys.modules, "torch", raising=False)

        tts = VibeVoiceTTS()
        assert tts.list_voices() == []


class TestSetVoice:
    def test_set_voice_updates_attribute(self):
        tts = VibeVoiceTTS()
        assert tts.voice == "Emma"
        tts.set_voice("Carter")
        assert tts.voice == "Carter"

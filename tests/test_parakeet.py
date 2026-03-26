"""Tests for Parakeet TTS engine utilities."""

import sys

import pytest

from src.tts.parakeet import ParakeetTTS


class TestIsAvailable:
    def test_available_when_deps_installed(self, monkeypatch):
        # Mock both transformers and torch as importable
        import types
        fake_transformers = types.ModuleType("transformers")
        fake_torch = types.ModuleType("torch")
        monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
        monkeypatch.setitem(sys.modules, "torch", fake_torch)
        assert ParakeetTTS.is_available() is True

    def test_unavailable_when_deps_missing(self, monkeypatch):
        # Force import to fail by removing modules and adding a failing import
        monkeypatch.delitem(sys.modules, "transformers", raising=False)
        monkeypatch.delitem(sys.modules, "torch", raising=False)

        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name in ("transformers", "torch"):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)
        assert ParakeetTTS.is_available() is False


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

        # Build a fake HF cache structure
        model_dir = tmp_path / "hub" / "models--nvidia--parakeet-tts-1.1b"
        model_dir.mkdir(parents=True)
        (model_dir / "snapshots" / "abc123").mkdir(parents=True)
        (model_dir / "snapshots" / "abc123" / "model.safetensors").write_text("fake")

        monkeypatch.setenv("HF_HOME", str(tmp_path))
        assert ParakeetTTS.is_model_downloaded("nvidia/parakeet-tts-1.1b") is True

    def test_filesystem_fallback_without_safetensors(self, tmp_path, monkeypatch):
        """When HF cache exists but no safetensors files, returns False."""
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name == "huggingface_hub":
                raise ImportError("No module named 'huggingface_hub'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)

        # Build cache dir without safetensors
        model_dir = tmp_path / "hub" / "models--nvidia--parakeet-tts-1.1b"
        model_dir.mkdir(parents=True)

        monkeypatch.setenv("HF_HOME", str(tmp_path))
        assert ParakeetTTS.is_model_downloaded("nvidia/parakeet-tts-1.1b") is False

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
        assert ParakeetTTS.is_model_downloaded("nvidia/parakeet-tts-1.1b") is False


class TestListVoices:
    def test_returns_one_voice_when_available(self, monkeypatch):
        import types
        monkeypatch.setitem(sys.modules, "transformers", types.ModuleType("transformers"))
        monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))

        # Stub is_model_downloaded to avoid filesystem access
        monkeypatch.setattr(ParakeetTTS, "is_model_downloaded", staticmethod(lambda *a, **kw: False))

        tts = ParakeetTTS()
        voices = tts.list_voices()

        assert len(voices) == 1
        v = voices[0]
        assert v["name"] == "Parakeet"
        assert v["lang"] == "en_US"
        assert v["downloaded"] is False
        assert v["needs_download"] is True
        assert "GB" in v["size_display"]

    def test_returns_empty_when_unavailable(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def blocked_import(name, *args, **kwargs):
            if name in ("transformers", "torch"):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", blocked_import)
        monkeypatch.delitem(sys.modules, "transformers", raising=False)
        monkeypatch.delitem(sys.modules, "torch", raising=False)

        tts = ParakeetTTS()
        assert tts.list_voices() == []

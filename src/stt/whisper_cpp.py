"""Whisper.cpp speech-to-text engine via pywhispercpp.

Lightweight alternative to openai-whisper — no PyTorch dependency.
Models are GGML format, downloaded on first use (~39MB tiny to ~2.9GB large).
"""

import logging
import os
from pathlib import Path
from typing import Callable

import httpx
import numpy as np

from ..audio.resample import resample_audio
from .base import TranscriptionResult

logger = logging.getLogger(__name__)

# HuggingFace base URL for GGML whisper models
_HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Map user-facing model names to GGML filenames
_MODEL_FILES = {
    "tiny": "ggml-tiny.bin",
    "base": "ggml-base.bin",
    "small": "ggml-small.bin",
    "medium": "ggml-medium.bin",
    "large": "ggml-large-v3-turbo.bin",
}


def _get_models_dir() -> Path:
    """Return the directory where GGML models are stored."""
    from pywhispercpp.utils import MODELS_DIR
    return Path(MODELS_DIR)


def _download_model(
    model_name: str,
    progress_callback: Callable[[str, float], None] | None = None,
) -> str:
    """Download a GGML model if not already cached.

    Returns the absolute path to the model file.
    """
    filename = _MODEL_FILES.get(model_name)
    if not filename:
        raise ValueError(
            f"Unknown model '{model_name}'. "
            f"Available: {', '.join(_MODEL_FILES)}"
        )

    models_dir = _get_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)
    model_path = models_dir / filename

    if model_path.exists():
        logger.info("Model '%s' already cached at %s", model_name, model_path)
        if progress_callback:
            progress_callback("ready", 1.0)
        return str(model_path)

    url = f"{_HF_BASE}/{filename}"
    logger.info("Downloading model '%s' from %s", model_name, url)
    if progress_callback:
        progress_callback("downloading", 0.0)

    # Stream download with progress
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(300, connect=5.0)) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        downloaded = 0

        tmp_path = model_path.with_suffix(".part")
        try:
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_bytes(chunk_size=64 * 1024):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback and total > 0:
                        progress_callback("downloading", downloaded / total)

            tmp_path.rename(model_path)
            logger.info("Model downloaded to %s", model_path)
            if progress_callback:
                progress_callback("ready", 1.0)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

    return str(model_path)


class WhisperCppSTT:
    """Speech-to-text using whisper.cpp via pywhispercpp.

    No PyTorch dependency. Models are GGML format, auto-downloaded on first use.
    """

    def __init__(
        self,
        model: str = "small",
        language: str | None = "en",
    ):
        self.model_name = model
        self.language = language
        self.progress_callback: Callable[[str, float], None] | None = None

        self._model = None
        self._loaded = False

    def _load_model(self) -> None:
        """Download (if needed) and load the GGML model."""
        if self._loaded:
            return

        from pywhispercpp.model import Model

        model_path = _download_model(self.model_name, self.progress_callback)

        if self.progress_callback:
            self.progress_callback("loading", 0.5)

        logger.info("Loading whisper.cpp model '%s'...", self.model_name)
        self._model = Model(
            model_path,
            redirect_whispercpp_logs_to=os.devnull,
            print_progress=False,
        )
        self._loaded = True
        logger.info("whisper.cpp model loaded")

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int = 16000,
    ) -> TranscriptionResult:
        """Transcribe audio to text."""
        self._load_model()

        # Convert to float32 if needed
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        elif audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # Resample if needed (whisper.cpp expects 16kHz)
        if sample_rate != 16000:
            audio = resample_audio(audio, sample_rate, 16000)

        duration = len(audio) / 16000.0

        segments = self._model.transcribe(
            audio,
            language=self.language or "en",
        )
        text = " ".join(seg.text for seg in segments).strip()

        return TranscriptionResult(
            text=text,
            language=self.language,
            confidence=None,
            duration=duration,
        )

    def transcribe_file(self, path: str) -> TranscriptionResult:
        """Transcribe audio from a file."""
        self._load_model()

        segments = self._model.transcribe(
            path,
            language=self.language or "en",
        )
        text = " ".join(seg.text for seg in segments).strip()

        return TranscriptionResult(
            text=text,
            language=self.language,
            confidence=None,
            duration=None,
        )



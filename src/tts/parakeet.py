"""NVIDIA Parakeet TTS engine.

Parakeet is a high-quality neural TTS model from NVIDIA.
https://huggingface.co/nvidia/parakeet-tts-1.1b

Can be run via:
- NeMo framework (full features, requires more setup)
- ONNX Runtime (lighter weight, easier deployment)
- HuggingFace Transformers (convenient API)
"""

import asyncio
import io
import logging
import tempfile
from pathlib import Path
from typing import Literal

import numpy as np

logger = logging.getLogger(__name__)


class ParakeetTTS:
    """Text-to-speech using NVIDIA Parakeet.

    Parakeet produces natural, expressive speech with excellent prosody.
    Well-suited for the warm, present quality desired in meditation facilitation.
    """

    def __init__(
        self,
        model_name: str = "nvidia/parakeet-tts-1.1b",
        device: str = "auto",
        backend: Literal["nemo", "onnx", "transformers"] = "transformers",
    ):
        """Initialize Parakeet TTS.

        Args:
            model_name: HuggingFace model name or path
            device: Device to run on ('auto', 'cpu', 'cuda', 'mps')
            backend: Which backend to use for inference
        """
        self.model_name = model_name
        self.device = device
        self.backend = backend

        self._model = None
        self._processor = None
        self._vocoder = None
        self._loaded = False
        self._speaking = False
        self._sample_rate = 22050

    def _load_model(self) -> None:
        """Lazy load the model."""
        if self._loaded:
            return

        if self.backend == "transformers":
            self._load_transformers()
        elif self.backend == "nemo":
            self._load_nemo()
        elif self.backend == "onnx":
            self._load_onnx()
        else:
            raise ValueError(f"Unknown backend: {self.backend}")

        self._loaded = True

    def _load_transformers(self) -> None:
        """Load using HuggingFace Transformers."""
        try:
            from transformers import AutoProcessor, AutoModelForTextToWaveform
            import torch
        except ImportError:
            raise ImportError(
                "transformers and torch required. Run: pip install transformers torch"
            )

        # Determine device
        device = self.device
        if device == "auto":
            if torch.cuda.is_available():
                device = "cuda"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"

        logger.info("Loading Parakeet model on %s...", device)

        self._processor = AutoProcessor.from_pretrained(self.model_name)
        self._model = AutoModelForTextToWaveform.from_pretrained(self.model_name)
        self._model.to(device)
        self._model.eval()
        self._device = device

    def _load_nemo(self) -> None:
        """Load using NVIDIA NeMo."""
        try:
            import nemo.collections.tts as nemo_tts
        except ImportError:
            raise ImportError(
                "NeMo required. Run: pip install nemo_toolkit[tts]"
            )

        logger.info("Loading Parakeet via NeMo...")
        self._model = nemo_tts.models.FastPitchModel.from_pretrained(self.model_name)
        self._vocoder = nemo_tts.models.HifiGanModel.from_pretrained("nvidia/tts_hifigan")

    def _load_onnx(self) -> None:
        """Load ONNX exported model."""
        try:
            import onnxruntime as ort
        except ImportError:
            raise ImportError(
                "onnxruntime required. Run: pip install onnxruntime"
            )

        # ONNX model path - user needs to export or download
        onnx_path = Path(self.model_name)
        if not onnx_path.exists():
            raise FileNotFoundError(
                f"ONNX model not found at {onnx_path}. "
                "Export the model first or use 'transformers' backend."
            )

        logger.info("Loading Parakeet ONNX model...")
        self._model = ort.InferenceSession(str(onnx_path))

    def _synthesize(self, text: str) -> np.ndarray:
        """Synthesize speech from text.

        Args:
            text: Text to synthesize

        Returns:
            Audio waveform as numpy array
        """
        self._load_model()

        if self.backend == "transformers":
            return self._synthesize_transformers(text)
        elif self.backend == "nemo":
            return self._synthesize_nemo(text)
        elif self.backend == "onnx":
            return self._synthesize_onnx(text)

    def _synthesize_transformers(self, text: str) -> np.ndarray:
        """Synthesize using Transformers backend."""
        import torch

        inputs = self._processor(text=text, return_tensors="pt")
        inputs = {k: v.to(self._device) for k, v in inputs.items()}

        with torch.no_grad():
            output = self._model(**inputs)

        waveform = output.waveform.squeeze().cpu().numpy()
        return waveform

    def _synthesize_nemo(self, text: str) -> np.ndarray:
        """Synthesize using NeMo backend."""
        import torch

        # Generate spectrogram
        with torch.no_grad():
            parsed = self._model.parse(text)
            spectrogram = self._model.generate_spectrogram(tokens=parsed)

            # Vocoder
            audio = self._vocoder.convert_spectrogram_to_audio(spec=spectrogram)

        return audio.squeeze().cpu().numpy()

    def _synthesize_onnx(self, text: str) -> np.ndarray:
        """Synthesize using ONNX backend."""
        # This is a simplified version - actual implementation depends on
        # how the model was exported
        raise NotImplementedError(
            "ONNX synthesis requires model-specific implementation. "
            "Use 'transformers' backend for now."
        )

    async def speak(self, text: str) -> None:
        """Speak the given text.

        Args:
            text: Text to speak
        """
        if not text.strip():
            return

        self._speaking = True
        try:
            # Run synthesis in thread pool to not block async loop
            loop = asyncio.get_event_loop()
            waveform = await loop.run_in_executor(None, self._synthesize, text)

            # Save to temp file and play
            await self._play_audio(waveform)

        finally:
            self._speaking = False

    async def _play_audio(self, waveform: np.ndarray) -> None:
        """Play audio waveform."""
        try:
            import sounddevice as sd

            # Play directly with sounddevice
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: sd.play(waveform, self._sample_rate, blocking=True)
            )
        except ImportError:
            # Fallback: save to file and use cross-platform player
            import scipy.io.wavfile as wav
            from ..audio.playback import play_audio_file

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                temp_path = f.name

            # Normalize and convert to int16
            waveform = waveform / np.max(np.abs(waveform))
            waveform_int = (waveform * 32767).astype(np.int16)
            wav.write(temp_path, self._sample_rate, waveform_int)

            await play_audio_file(temp_path)

            Path(temp_path).unlink(missing_ok=True)

    def stop(self) -> None:
        """Stop current speech."""
        self._speaking = False
        # Note: stopping mid-playback requires more complex audio handling

    def is_speaking(self) -> bool:
        """Check if currently speaking."""
        return self._speaking

    def set_voice(self, voice: str) -> None:
        """Set voice (Parakeet uses single voice, this is a no-op)."""
        pass

    def set_rate(self, rate: int) -> None:
        """Set speaking rate (not directly supported, would need post-processing)."""
        pass

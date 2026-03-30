"""Microsoft VibeVoice Realtime TTS engine.

VibeVoice-Realtime is a high-quality neural TTS model with ~300ms first-audio
latency and streaming support. Uses a next-token diffusion framework.
https://github.com/microsoft/VibeVoice
"""

from __future__ import annotations

import asyncio
import io
import logging
import wave
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# Available English voice presets bundled with the model.
VIBEVOICE_VOICES = [
    {"name": "Emma", "file": "en-Emma_woman.pt", "gender": "female", "recommended": True},
    {"name": "Grace", "file": "en-Grace_woman.pt", "gender": "female"},
    {"name": "Carter", "file": "en-Carter_man.pt", "gender": "male", "recommended": True},
    {"name": "Davis", "file": "en-Davis_man.pt", "gender": "male"},
    {"name": "Frank", "file": "en-Frank_man.pt", "gender": "male"},
    {"name": "Mike", "file": "en-Mike_man.pt", "gender": "male"},
]

DEFAULT_MODEL = "microsoft/VibeVoice-Realtime-0.5B"
DEFAULT_VOICE = "Emma"
SAMPLE_RATE = 24000


def _resolve_voice_file(voice_name: str) -> str | None:
    """Return the .pt filename for a voice name, or None."""
    for v in VIBEVOICE_VOICES:
        if v["name"].lower() == voice_name.lower():
            return v["file"]
    return None


class VibeVoiceTTS:
    """Text-to-speech using Microsoft VibeVoice-Realtime.

    High-quality local neural TTS with 6 English voice presets.
    Requires a GPU (CUDA) or Apple Silicon (MPS) for real-time performance.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: str = "auto",
        voice: str = DEFAULT_VOICE,
        num_steps: int = 5,
    ):
        self.model_name = model_name
        self.voice = voice
        self.rate = 180
        self.device = device
        self.num_steps = num_steps

        self._model = None
        self._processor = None
        self._voice_cache: dict[str, object] = {}
        self._loaded = False
        self._speaking = False

    def _load_model(self) -> None:
        """Lazy-load the model and processor."""
        if self._loaded:
            return

        if not self.is_model_downloaded(self.model_name):
            logger.warning("VibeVoice model not downloaded — download it from Settings first")
            return

        try:
            import torch
            from vibevoice.modular.modeling_vibevoice_streaming_inference import (
                VibeVoiceStreamingForConditionalGenerationInference,
            )
            from vibevoice.processor.vibevoice_streaming_processor import (
                VibeVoiceStreamingProcessor,
            )
        except ImportError:
            raise ImportError(
                "vibevoice and torch required. Run: pip install vibevoice[streamingtts] torch"
            )

        # Pick device, dtype, and attention implementation
        device = self.device
        if device == "auto":
            if torch.cuda.is_available():
                device = "cuda"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"

        if device == "cuda":
            dtype = torch.bfloat16
            try:
                import flash_attn  # noqa: F401
                attn_impl = "flash_attention_2"
            except ImportError:
                attn_impl = "sdpa"
        else:
            dtype = torch.float32
            attn_impl = "sdpa"

        logger.info("Loading VibeVoice model on %s (dtype=%s, attn=%s)...", device, dtype, attn_impl)

        self._processor = VibeVoiceStreamingProcessor.from_pretrained(self.model_name)
        # Use device_map only for CUDA (accelerate handles multi-GPU dispatch).
        # For MPS/CPU, load weights normally and .to(device) to avoid
        # "Cannot copy out of meta tensor" errors.
        if device == "cuda":
            self._model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                self.model_name,
                torch_dtype=dtype,
                device_map=device,
                attn_implementation=attn_impl,
            )
        else:
            self._model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                self.model_name,
                torch_dtype=dtype,
                attn_implementation=attn_impl,
            ).to(device)
        self._model.eval()
        self._model.set_ddpm_inference_steps(num_steps=self.num_steps)
        self._device = device
        self._dtype = dtype
        self._loaded = True

    def _get_voice_preset(self, voice_name: str):
        """Load and cache a voice preset .pt file."""
        import torch

        if voice_name in self._voice_cache:
            return self._voice_cache[voice_name]

        voice_file = _resolve_voice_file(voice_name)
        if voice_file is None:
            logger.warning("Unknown voice '%s', falling back to %s", voice_name, DEFAULT_VOICE)
            voice_file = _resolve_voice_file(DEFAULT_VOICE)

        # Resolve path from HF cache
        try:
            from huggingface_hub import hf_hub_download
            preset_path = hf_hub_download(
                self.model_name,
                f"voices/streaming_model/{voice_file}",
                local_files_only=True,
            )
        except Exception:
            # Fallback: scan HF cache manually
            import os
            hf_home = os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")
            cache_dir = Path(hf_home) / "hub" / ("models--" + self.model_name.replace("/", "--"))
            matches = list(cache_dir.rglob(voice_file))
            if not matches:
                logger.error("Voice preset file not found: %s", voice_file)
                return None
            preset_path = str(matches[0])

        preset = torch.load(preset_path, map_location=self._device, weights_only=False)
        self._voice_cache[voice_name] = preset
        return preset

    def _synthesize(self, text: str) -> np.ndarray | None:
        """Synthesize text to a 24kHz numpy audio array."""
        self._load_model()
        if not self._loaded:
            return None

        voice_data = self._get_voice_preset(self.voice)
        if voice_data is None:
            return None

        inputs = self._processor.process_input_with_cached_prompt(
            text=text,
            cached_prompt=voice_data,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )

        import copy as _copy
        outputs = self._model.generate(
            **inputs,
            max_new_tokens=None,
            cfg_scale=1.5,
            tokenizer=self._processor.tokenizer,
            generation_config={"do_sample": False},
            all_prefilled_outputs=_copy.deepcopy(voice_data),
        )

        return outputs.speech_outputs[0]

    def speak_to_bytes(self, text: str) -> bytes | None:
        """Generate speech as WAV bytes (synchronous, blocking)."""
        if not text.strip():
            return None

        try:
            waveform = self._synthesize(text)
            if waveform is None:
                return None

            # Normalize and convert to 16-bit PCM
            waveform = np.asarray(waveform, dtype=np.float32)
            peak = np.max(np.abs(waveform))
            if peak > 0:
                waveform = waveform / peak
            pcm = (waveform * 32767).astype(np.int16).tobytes()

            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(pcm)
            return buf.getvalue()
        except Exception as e:
            logger.error("VibeVoice speak_to_bytes error: %s", e)
            return None

    async def speak(self, text: str) -> None:
        """Speak the given text."""
        if not text.strip():
            return

        self._speaking = True
        try:
            loop = asyncio.get_event_loop()
            wav_bytes = await loop.run_in_executor(None, self.speak_to_bytes, text)
            if wav_bytes:
                from ..audio.playback import play_audio_bytes
                await play_audio_bytes(wav_bytes, sample_rate=SAMPLE_RATE)
        finally:
            self._speaking = False

    def stop(self) -> None:
        """Stop current speech."""
        self._speaking = False

    def is_speaking(self) -> bool:
        """Check if currently speaking."""
        return self._speaking

    def set_voice(self, voice: str) -> None:
        """Set the voice preset to use."""
        self.voice = voice

    def set_rate(self, rate: int) -> None:
        """Set speaking rate (not directly supported by VibeVoice)."""
        pass

    @staticmethod
    def is_available() -> bool:
        """Check if VibeVoice dependencies are installed."""
        try:
            import vibevoice  # noqa: F401
            import torch  # noqa: F401
            return True
        except ImportError:
            return False

    @staticmethod
    def is_model_downloaded(model_name: str = DEFAULT_MODEL) -> bool:
        """Check if the VibeVoice model and voice presets are cached locally."""
        has_model = False
        try:
            from huggingface_hub import try_to_load_from_cache, _CACHED_NO_EXIST
            result = try_to_load_from_cache(model_name, "config.json")
            has_model = result is not None and result is not _CACHED_NO_EXIST
        except Exception:
            pass
        if not has_model:
            # Fallback: check common HF cache locations
            import os
            hf_home = os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")
            cache_dir = Path(hf_home) / "hub" / ("models--" + model_name.replace("/", "--"))
            has_model = cache_dir.exists() and any(cache_dir.rglob("*.safetensors"))
        if not has_model:
            return False
        # Also verify at least one voice preset exists
        try:
            from huggingface_hub import hf_hub_download
            hf_hub_download(model_name, f"voices/streaming_model/{VIBEVOICE_VOICES[0]['file']}",
                            local_files_only=True)
            return True
        except Exception:
            return False

    def list_voices(self) -> list[dict]:
        """List available VibeVoice voice presets."""
        if not self.is_available():
            return []
        model_downloaded = self.is_model_downloaded(self.model_name)
        voices = []
        for v in VIBEVOICE_VOICES:
            entry = {
                "name": v["name"],
                "lang": "en_US",
                "downloaded": model_downloaded,
                "size_display": "~1.9 GB (shared model)",
                "needs_download": True,
            }
            if v.get("recommended"):
                entry["recommended"] = True
            voices.append(entry)
        return voices

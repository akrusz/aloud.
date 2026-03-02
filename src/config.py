"""Configuration loading and management."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class AudioConfig:
    input_device: str | int | None = None
    sample_rate: int = 16000
    channels: int = 1
    chunk_size: int = 480
    vad_sensitivity: int = 2


@dataclass
class STTConfig:
    engine: str = "whisper"
    model: str = "small"
    language: str = "en"
    device: str = "auto"


@dataclass
class TTSConfig:
    engine: str = "macos"
    voice: str = "Samantha"
    rate: int = 120

    # Parakeet options
    model_name: str = "nvidia/parakeet-tts-1.1b"
    backend: str = "transformers"  # transformers, nemo, onnx
    device: str = "auto"

    # ElevenLabs options
    api_key: str | None = None
    voice_id: str | None = None
    model_id: str = "eleven_monolingual_v1"
    stability: float = 0.75
    similarity_boost: float = 0.75


@dataclass
class LLMConfig:
    provider: str = "claude_proxy"
    model: str = "claude-sonnet-4-5-20250929"
    proxy_url: str = "http://127.0.0.1:8317"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3"
    api_key: str | None = None
    openai_base_url: str | None = None
    context_strategy: str = "full"
    window_size: int = 100
    max_tokens: int = 300


@dataclass
class PacingConfig:
    response_delay_ms: int = 2000
    min_speech_duration_ms: int = 500
    extended_silence_sec: int = 60


@dataclass
class FacilitationConfig:
    directiveness: int = 3
    focuses: list[str] = field(default_factory=list)
    qualities: list[str] = field(default_factory=list)
    orient_pleasant: bool | None = None  # None = not set, fall back to pleasant_emphasis
    verbosity: str = "medium"
    custom_instructions: str = ""
    # Legacy — used as fallback when orient_pleasant is not set
    pleasant_emphasis: bool = True


@dataclass
class SessionConfig:
    auto_save: bool = True
    save_directory: str = "sessions"
    include_timestamps: bool = True


@dataclass
class Config:
    """Complete application configuration."""

    audio: AudioConfig = field(default_factory=AudioConfig)
    stt: STTConfig = field(default_factory=STTConfig)
    tts: TTSConfig = field(default_factory=TTSConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    pacing: PacingConfig = field(default_factory=PacingConfig)
    facilitation: FacilitationConfig = field(default_factory=FacilitationConfig)
    session: SessionConfig = field(default_factory=SessionConfig)


def load_config(path: str | Path | None = None) -> Config:
    """Load configuration from YAML file.

    Args:
        path: Path to config file. If None, uses default.yaml

    Returns:
        Loaded configuration
    """
    if path is None:
        # Try default locations
        candidates = [
            Path("config/default.yaml"),
            Path("config.yaml"),
            Path.home() / ".config" / "somatic-facilitator" / "config.yaml",
        ]
        for candidate in candidates:
            if candidate.exists():
                path = candidate
                break

    config = Config()

    if path is not None and Path(path).exists():
        with open(path) as f:
            data = yaml.safe_load(f) or {}

        # Update config from YAML
        if "audio" in data:
            config.audio = _update_dataclass(AudioConfig(), data["audio"])
        if "stt" in data:
            config.stt = _update_dataclass(STTConfig(), data["stt"])
        if "tts" in data:
            config.tts = _update_dataclass(TTSConfig(), data["tts"])
        if "llm" in data:
            llm_data = data["llm"]
            # Flatten nested context config — only override dataclass
            # defaults for keys explicitly present in the YAML.
            if "context" in llm_data:
                ctx = llm_data.pop("context")
                if "strategy" in ctx:
                    llm_data["context_strategy"] = ctx["strategy"]
                if "window_size" in ctx:
                    llm_data["window_size"] = ctx["window_size"]
                if "max_tokens" in ctx:
                    llm_data["max_tokens"] = ctx["max_tokens"]
            config.llm = _update_dataclass(LLMConfig(), llm_data)
        if "pacing" in data:
            config.pacing = _update_dataclass(PacingConfig(), data["pacing"])
        if "facilitation" in data:
            config.facilitation = _update_dataclass(FacilitationConfig(), data["facilitation"])
        if "session" in data:
            config.session = _update_dataclass(SessionConfig(), data["session"])

    # Handle environment variable substitution for API keys
    if config.llm.api_key and config.llm.api_key.startswith("${"):
        env_var = config.llm.api_key[2:-1]
        config.llm.api_key = os.environ.get(env_var)

    if config.tts.api_key and config.tts.api_key.startswith("${"):
        env_var = config.tts.api_key[2:-1]
        config.tts.api_key = os.environ.get(env_var)

    return config


def _update_dataclass(instance: Any, data: dict) -> Any:
    """Update dataclass instance from dictionary."""
    for key, value in data.items():
        if hasattr(instance, key):
            setattr(instance, key, value)
    return instance

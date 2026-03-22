"""Configuration loading and management."""

import os
from dataclasses import dataclass, field, fields, asdict
from pathlib import Path
from typing import Any

import yaml
from platformdirs import user_config_dir

APP_NAME = "Glooow"
APP_AUTHOR = "Glooow"


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
    model_id: str = "eleven_v3"
    stability: float = 0.75
    similarity_boost: float = 0.75


@dataclass
class LLMConfig:
    provider: str = "claude_proxy"
    model: str = "claude-sonnet-4-6"
    proxy_url: str = "http://127.0.0.1:8317"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3.5:4b"
    api_key: str | None = "glooow"  # default for claude_proxy; overridden by config file
    openai_base_url: str | None = None
    context_strategy: str = "full"
    window_size: int = 100
    max_tokens: int = 400

    @property
    def effective_model(self) -> str:
        """Return the right model for the configured provider."""
        return self.effective_model_for(self.provider)

    def effective_model_for(self, provider: str) -> str:
        """Return the right model for a given provider.

        When provider is 'ollama', uses ollama_model instead of the
        main model field (which typically holds the claude model name).
        """
        if provider == "ollama":
            return self.ollama_model
        return self.model


@dataclass
class PacingConfig:
    response_delay_ms: int = 2000
    min_speech_duration_ms: int = 500
    extended_silence_sec: int = 300


@dataclass
class FacilitationConfig:
    directiveness: int = 3
    focuses: list[str] = field(default_factory=list)
    qualities: list[str] = field(default_factory=list)
    verbosity: str = "medium"
    custom_instructions: str = ""


@dataclass
class SessionConfig:
    auto_save: bool = True
    save_directory: str = "sessions"
    include_timestamps: bool = True


@dataclass
class AuthConfig:
    enabled: bool = False
    password: str = ""


@dataclass
class WebConfig:
    """Web server configuration."""

    secret_key: str = "glooow-local"
    host: str = "0.0.0.0"
    port: int = 4649


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
    web: WebConfig = field(default_factory=WebConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)


def get_user_config_dir() -> Path:
    """Return the OS-appropriate config directory for Glooow.

    - macOS:  ~/Library/Application Support/Glooow
    - Windows: %APPDATA%/Glooow/Glooow
    - Linux:  ~/.config/Glooow
    """
    return Path(user_config_dir(APP_NAME, APP_AUTHOR))


def get_user_config_path() -> Path:
    """Return the path to the user's config file."""
    return get_user_config_dir() / "config.yaml"


def has_user_config() -> bool:
    """Check whether a user config file exists."""
    return get_user_config_path().is_file()


def save_user_config(data: dict) -> Path:
    """Save user configuration overrides to the OS config directory.

    Only saves non-default values. Returns the path written to.
    """
    path = get_user_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Merge with existing user config if present
    existing = {}
    if path.is_file():
        with open(path) as f:
            existing = yaml.safe_load(f) or {}

    _deep_merge(existing, data)

    with open(path, "w") as f:
        yaml.dump(existing, f, default_flow_style=False, sort_keys=False)

    return path


def load_user_config() -> dict:
    """Load the user config file as a raw dict. Returns {} if not found."""
    path = get_user_config_path()
    if not path.is_file():
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def config_to_dict(config: Config) -> dict:
    """Convert a Config dataclass tree to a plain dict."""
    return asdict(config)


def _deep_merge(base: dict, override: dict) -> None:
    """Merge override into base in-place, recursing into nested dicts."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value


def load_config(path: str | Path | None = None) -> Config:
    """Load configuration from YAML file.

    Args:
        path: Path to config file. If None, uses default.yaml

    Returns:
        Loaded configuration
    """
    if path is None:
        # Try default locations (most specific first)
        candidates = [
            get_user_config_path(),
            Path("config/default.yaml"),
            Path("config.yaml"),
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
        if "web" in data:
            config.web = _update_dataclass(WebConfig(), data["web"])
        if "auth" in data:
            config.auth = _update_dataclass(AuthConfig(), data["auth"])

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

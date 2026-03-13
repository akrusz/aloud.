"""Tests for configuration loading."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from src.config import (
    AudioConfig,
    Config,
    LLMConfig,
    PacingConfig,
    TTSConfig,
    WebConfig,
    _update_dataclass,
    load_config,
)


class TestDefaults:
    def test_default_config(self):
        config = Config()
        assert config.audio.sample_rate == 16000
        assert config.stt.engine == "whisper"
        assert config.tts.engine == "macos"
        assert config.llm.provider == "claude_proxy"
        assert config.pacing.response_delay_ms == 2000
        assert config.session.auto_save is True
        assert config.web.port == 4649
        assert config.web.host == "0.0.0.0"

    def test_pacing_config_defaults(self):
        config = PacingConfig()
        assert config.response_delay_ms == 2000
        assert config.min_speech_duration_ms == 500
        assert config.extended_silence_sec == 300

    def test_web_config_defaults(self):
        config = WebConfig()
        assert config.secret_key == "glooow-local"
        assert config.host == "0.0.0.0"
        assert config.port == 4649


class TestUpdateDataclass:
    def test_updates_known_fields(self):
        config = AudioConfig()
        result = _update_dataclass(config, {"sample_rate": 44100})
        assert result.sample_rate == 44100

    def test_ignores_unknown_fields(self):
        config = AudioConfig()
        result = _update_dataclass(config, {"nonexistent_field": "value"})
        assert not hasattr(result, "nonexistent_field")

    def test_returns_same_instance(self):
        config = AudioConfig()
        result = _update_dataclass(config, {"sample_rate": 44100})
        assert result is config

    def test_multiple_fields(self):
        config = LLMConfig()
        result = _update_dataclass(config, {
            "provider": "openai",
            "model": "gpt-4",
            "max_tokens": 1000,
        })
        assert result.provider == "openai"
        assert result.model == "gpt-4"
        assert result.max_tokens == 1000


class TestLoadConfig:
    def test_load_nonexistent_returns_defaults(self, tmp_path):
        config = load_config(tmp_path / "nonexistent.yaml")
        assert config.audio.sample_rate == 16000
        assert config.llm.provider == "claude_proxy"

    def test_load_yaml(self, tmp_path):
        yaml_content = """
llm:
    provider: openai
    model: gpt-4
pacing:
    response_delay_ms: 3000
web:
    port: 8080
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        config = load_config(config_file)
        assert config.llm.provider == "openai"
        assert config.llm.model == "gpt-4"
        assert config.pacing.response_delay_ms == 3000
        assert config.web.port == 8080

    def test_nested_llm_context(self, tmp_path):
        yaml_content = """
llm:
    provider: openai
    context:
        strategy: rolling
        window_size: 5
        max_tokens: 200
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        config = load_config(config_file)
        assert config.llm.context_strategy == "rolling"
        assert config.llm.window_size == 5
        assert config.llm.max_tokens == 200


class TestEnvVarSubstitution:
    def test_llm_api_key_env_var(self, tmp_path):
        yaml_content = """
llm:
    api_key: ${MY_TEST_API_KEY}
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        with patch.dict(os.environ, {"MY_TEST_API_KEY": "sk-test-123"}):
            config = load_config(config_file)
        assert config.llm.api_key == "sk-test-123"

    def test_missing_env_var_becomes_none(self, tmp_path):
        yaml_content = """
llm:
    api_key: ${MISSING_KEY_12345}
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MISSING_KEY_12345", None)
            config = load_config(config_file)
        assert config.llm.api_key is None

    def test_tts_api_key_env_var(self, tmp_path):
        yaml_content = """
tts:
    api_key: ${MY_TTS_KEY}
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        with patch.dict(os.environ, {"MY_TTS_KEY": "tts-abc"}):
            config = load_config(config_file)
        assert config.tts.api_key == "tts-abc"

    def test_literal_api_key_not_substituted(self, tmp_path):
        yaml_content = """
llm:
    api_key: sk-literal-key
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        config = load_config(config_file)
        assert config.llm.api_key == "sk-literal-key"

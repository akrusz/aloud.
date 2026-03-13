"""Shared fixtures for glooow tests."""

import pytest

from src.config import Config, PacingConfig, LLMConfig
from src.facilitation.pacing import PacingController
from src.facilitation.prompts import PromptBuilder, PromptConfig
from src.facilitation.session import SessionManager


@pytest.fixture
def default_config():
    return Config()


@pytest.fixture
def pacing_config():
    return PacingConfig()


@pytest.fixture
def pacing_controller(pacing_config):
    return PacingController(pacing_config)


@pytest.fixture
def prompt_builder():
    return PromptBuilder()


@pytest.fixture
def session_manager():
    return SessionManager()


@pytest.fixture
def rolling_session_manager():
    return SessionManager(context_strategy="rolling", window_size=3)


@pytest.fixture
def prompt_config():
    return PromptConfig()

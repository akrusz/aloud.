"""Tests for Voice Activity Detection."""

import time
from unittest.mock import patch

import numpy as np
import pytest

from src.audio.vad import (
    SpeechState,
    VADConfig,
    VoiceActivityDetector,
    create_vad,
)


def _silence(duration_s=0.1, sample_rate=16000):
    """Generate silent audio."""
    return np.zeros(int(sample_rate * duration_s), dtype=np.float32)


def _speech(duration_s=0.1, sample_rate=16000, amplitude=0.3):
    """Generate speech-like audio (loud enough to trigger detection)."""
    samples = int(sample_rate * duration_s)
    t = np.linspace(0, duration_s, samples, dtype=np.float32)
    return amplitude * np.sin(2 * np.pi * 200 * t)


@pytest.fixture
def vad():
    config = VADConfig(
        energy_threshold=0.02,
        min_speech_duration=0.3,
        speech_end_silence=1.5,
    )
    return VoiceActivityDetector(config)


class TestEnergyCalculation:
    def test_silence_has_zero_energy(self, vad):
        energy = vad._calculate_energy(_silence())
        assert energy < 0.001

    def test_speech_has_positive_energy(self, vad):
        energy = vad._calculate_energy(_speech())
        assert energy > 0.1

    def test_empty_audio(self, vad):
        energy = vad._calculate_energy(np.array([], dtype=np.float32))
        assert energy == 0.0

    def test_int16_normalization(self, vad):
        audio_f32 = _speech(amplitude=0.5)
        audio_i16 = (audio_f32 * 32768).astype(np.int16)
        energy_f32 = vad._calculate_energy(audio_f32)
        energy_i16 = vad._calculate_energy(audio_i16)
        assert abs(energy_f32 - energy_i16) < 0.01


class TestStateMachine:
    def test_initial_state_is_silence(self, vad):
        assert vad._state == SpeechState.SILENCE

    def test_speech_starts_detection(self, vad):
        result = vad.process(_speech())
        assert result.is_speech
        assert result.state == SpeechState.SPEECH_STARTED

    def test_silence_stays_silent(self, vad):
        result = vad.process(_silence())
        assert not result.is_speech
        assert result.state == SpeechState.SILENCE

    def test_speech_to_speaking_after_min_duration(self, vad):
        # Process speech chunks until min_speech_duration is met
        # Need to advance time, so we mock time.time
        base = time.time()
        with patch("src.audio.vad.time") as mock_time:
            mock_time.time.return_value = base
            vad.process(_speech())  # SPEECH_STARTED

            mock_time.time.return_value = base + 0.4  # past min_speech_duration of 0.3s
            result = vad.process(_speech())
            assert result.state == SpeechState.SPEAKING

    def test_short_sound_returns_to_silence(self, vad):
        base = time.time()
        with patch("src.audio.vad.time") as mock_time:
            mock_time.time.return_value = base
            vad.process(_speech())  # SPEECH_STARTED

            mock_time.time.return_value = base + 0.3
            result = vad.process(_silence())  # short sound, silence after 0.3s > 0.2s
            assert result.state == SpeechState.SILENCE

    def test_speech_ended_after_silence_gap(self, vad):
        base = time.time()
        with patch("src.audio.vad.time") as mock_time:
            mock_time.time.return_value = base
            vad.process(_speech())  # SPEECH_STARTED

            mock_time.time.return_value = base + 0.4
            vad.process(_speech())  # SPEAKING

            mock_time.time.return_value = base + 2.0  # 1.6s of silence > 1.5s threshold
            result = vad.process(_silence())
            assert result.state == SpeechState.SPEECH_ENDED

    def test_speech_ended_is_transient(self, vad):
        base = time.time()
        with patch("src.audio.vad.time") as mock_time:
            mock_time.time.return_value = base
            vad.process(_speech())

            mock_time.time.return_value = base + 0.4
            vad.process(_speech())  # SPEAKING

            mock_time.time.return_value = base + 2.0
            vad.process(_silence())  # SPEECH_ENDED

            mock_time.time.return_value = base + 2.1
            result = vad.process(_silence())  # Should transition to SILENCE
            assert result.state == SpeechState.SILENCE


class TestAdaptiveThreshold:
    def test_noise_floor_updates_during_silence(self, vad):
        initial_floor = vad._noise_floor
        # Process low-energy noise
        noise = np.random.randn(1600).astype(np.float32) * 0.005
        for _ in range(50):
            vad.process(noise)
        # Noise floor should have moved toward the noise energy
        assert vad._noise_floor != initial_floor

    def test_noise_floor_not_updated_during_speech(self, vad):
        # Get into SPEECH_STARTED state
        vad.process(_speech())
        floor_after_start = vad._noise_floor
        # Process more speech — floor should not change
        vad.process(_speech())
        assert vad._noise_floor == floor_after_start


class TestReset:
    def test_reset_state(self, vad):
        vad.process(_speech())
        vad.reset()
        assert vad._state == SpeechState.SILENCE
        assert vad._speech_start_time is None
        assert vad._last_speech_time == 0
        assert vad._noise_floor == 0.01
        assert vad._noise_samples == 0


class TestSensitivity:
    def test_high_sensitivity_lowers_threshold(self):
        config_high = VADConfig(energy_threshold=0.02, sensitivity=3)
        vad_high = VoiceActivityDetector(config_high)

        config_low = VADConfig(energy_threshold=0.02, sensitivity=0)
        vad_low = VoiceActivityDetector(config_low)

        assert vad_high.config.energy_threshold < vad_low.config.energy_threshold

    def test_default_sensitivity_unchanged(self):
        config = VADConfig(energy_threshold=0.02, sensitivity=2)
        vad = VoiceActivityDetector(config)
        assert vad.config.energy_threshold == 0.02  # multiplier 1.0


class TestFactory:
    def test_create_energy_vad(self):
        vad = create_vad(method="energy")
        assert isinstance(vad, VoiceActivityDetector)

    def test_create_unknown_raises(self):
        with pytest.raises(ValueError, match="Unknown VAD method"):
            create_vad(method="unknown")

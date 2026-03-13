"""Tests for the pacing / turn-taking controller."""

import time
from unittest.mock import patch

import pytest

from src.config import PacingConfig
from src.facilitation.pacing import (
    ConversationState,
    PacingController,
    TurnDecision,
)


class TestStateTransitions:
    def test_initial_state_is_idle(self, pacing_controller):
        assert pacing_controller.state == ConversationState.IDLE

    def test_start_session_transitions_to_listening(self, pacing_controller):
        pacing_controller.start_session()
        assert pacing_controller.state == ConversationState.LISTENING

    def test_end_session_transitions_to_idle(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.end_session()
        assert pacing_controller.state == ConversationState.IDLE

    def test_speech_end_transitions_to_processing(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.on_speech_end()
        assert pacing_controller.state == ConversationState.PROCESSING

    def test_speech_start_transitions_to_listening(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.on_speech_end()
        pacing_controller.on_speech_start()
        assert pacing_controller.state == ConversationState.LISTENING

    def test_response_start_transitions_to_responding(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.on_response_start()
        assert pacing_controller.state == ConversationState.RESPONDING

    def test_response_end_transitions_to_listening(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.on_response_start()
        pacing_controller.on_response_end()
        assert pacing_controller.state == ConversationState.LISTENING

    def test_enter_silence_mode_transitions_to_silent_hold(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.enter_silence_mode()
        assert pacing_controller.state == ConversationState.SILENT_HOLD

    def test_exit_silence_mode_transitions_to_listening(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.enter_silence_mode()
        pacing_controller.exit_silence_mode()
        assert pacing_controller.state == ConversationState.LISTENING


class TestSilenceMode:
    def test_is_in_silence_mode(self, pacing_controller):
        pacing_controller.start_session()
        assert not pacing_controller.is_in_silence_mode()
        pacing_controller.enter_silence_mode()
        assert pacing_controller.is_in_silence_mode()
        pacing_controller.exit_silence_mode()
        assert not pacing_controller.is_in_silence_mode()

    def test_should_respond_returns_hold_in_silence_mode(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.enter_silence_mode()
        assert pacing_controller.should_respond() == TurnDecision.HOLD

    def test_transcription_exits_silence_mode(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.enter_silence_mode()
        result = pacing_controller.on_transcription("I'm ready")
        assert result == TurnDecision.RESPOND
        assert not pacing_controller.is_in_silence_mode()

    def test_speech_start_resets_check_in_count(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.on_check_in()
        pacing_controller.on_check_in()
        assert pacing_controller._check_in_count == 2
        pacing_controller.on_speech_start()
        assert pacing_controller._check_in_count == 0


class TestShouldRespond:
    def test_wait_when_no_speech(self, pacing_controller):
        pacing_controller.start_session()
        assert pacing_controller.should_respond() == TurnDecision.WAIT

    def test_respond_after_response_delay(self, pacing_controller):
        pacing_controller.start_session()
        # Simulate speech ending 5 seconds ago (default delay is 2s)
        pacing_controller._last_speech_end = time.time() - 5
        assert pacing_controller.should_respond() == TurnDecision.RESPOND

    def test_wait_during_response_delay(self):
        config = PacingConfig(response_delay_ms=5000)
        controller = PacingController(config)
        controller.start_session()
        controller._last_speech_end = time.time() - 1  # 1s ago, delay is 5s
        assert controller.should_respond() == TurnDecision.WAIT

    def test_response_end_resets_speech_end(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller._last_speech_end = time.time() - 5
        pacing_controller.on_response_end()
        # After response, last_speech_end is reset to 0
        assert pacing_controller._last_speech_end == 0


class TestExponentialBackoff:
    def test_check_in_after_extended_silence(self):
        config = PacingConfig(extended_silence_sec=10)
        controller = PacingController(config)
        controller.start_session()
        controller._has_spoken = True
        # Set last response time to 11 seconds ago
        controller._last_response_time = time.time() - 11
        assert controller.should_respond() == TurnDecision.CHECK_IN

    def test_backoff_doubles_threshold(self):
        config = PacingConfig(extended_silence_sec=10)
        controller = PacingController(config)
        controller.start_session()
        controller._has_spoken = True
        controller.on_check_in()  # count = 1, threshold = 10 * 2^1 = 20s
        controller._last_response_time = time.time() - 15
        # 15s < 20s threshold, should wait
        assert controller.should_respond() == TurnDecision.WAIT

    def test_backoff_after_two_check_ins(self):
        config = PacingConfig(extended_silence_sec=10)
        controller = PacingController(config)
        controller.start_session()
        controller._has_spoken = True
        controller.on_check_in()
        controller.on_check_in()  # count = 2, threshold = 10 * 2^2 = 40s
        controller._last_response_time = time.time() - 35
        # 35s < 40s threshold
        assert controller.should_respond() == TurnDecision.WAIT

    def test_no_check_in_before_first_speech(self):
        config = PacingConfig(extended_silence_sec=10)
        controller = PacingController(config)
        controller.start_session()
        # _has_spoken is False
        controller._last_response_time = time.time() - 100
        assert controller.should_respond() == TurnDecision.WAIT


class TestSilenceDuration:
    def test_silence_duration_in_silence_mode(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller.enter_silence_mode()
        # Duration should be small but non-negative
        d = pacing_controller.get_silence_duration()
        assert d >= 0

    def test_silence_duration_after_speech(self, pacing_controller):
        pacing_controller.start_session()
        pacing_controller._last_speech_end = time.time() - 5
        d = pacing_controller.get_silence_duration()
        assert d >= 4.5  # allow some timing slop

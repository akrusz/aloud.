"""Pacing and turn-taking logic for meditation facilitation.

This is the most nuanced component - distinguishing between:
- Thinking pause (2-5 sec): Wait silently
- Contemplative dropping-in (5-30 sec): Wait silently
- Natural end of sharing (3-5 sec + falling intonation): Respond
- LLM-detected silence intent ([HOLD] signal): Enter extended listening mode
- Very long silence (120+ sec): Gentle check-in (optional)
"""

import time
from enum import Enum, auto

from ..config import PacingConfig


class ConversationState(Enum):
    """Current state of the conversation."""

    IDLE = auto()  # Session not started
    LISTENING = auto()  # Actively listening to meditator
    PROCESSING = auto()  # Processing what was said
    RESPONDING = auto()  # Facilitator is speaking
    SILENT_HOLD = auto()  # Extended silence mode (meditator requested)


class TurnDecision(Enum):
    """Decision about whether to take a turn."""

    WAIT = auto()  # Continue waiting
    RESPOND = auto()  # Time to respond
    CHECK_IN = auto()  # Gentle check-in after long silence
    HOLD = auto()  # In silence mode, keep holding


class PacingController:
    """Controls turn-taking dynamics in meditation facilitation.

    Handles the nuanced timing of when the facilitator should speak,
    respecting the meditator's contemplative process.
    """

    def __init__(self, config: PacingConfig | None = None):
        self.config = config or PacingConfig()

        self._state = ConversationState.IDLE
        self._last_speech_end: float = 0
        self._last_response_time: float = 0
        self._silence_mode_start: float | None = None
        self._check_in_count: int = 0
        self._has_spoken: bool = False

    @property
    def state(self) -> ConversationState:
        """Current conversation state."""
        return self._state

    def start_session(self) -> None:
        """Start a new meditation session."""
        self._state = ConversationState.LISTENING
        self._last_speech_end = 0
        self._last_response_time = time.time()
        self._silence_mode_start = None
        self._check_in_count = 0
        self._has_spoken = False

    def end_session(self) -> None:
        """End the current session."""
        self._state = ConversationState.IDLE

    def on_speech_start(self) -> None:
        """Called when meditator starts speaking."""
        self._state = ConversationState.LISTENING
        self._check_in_count = 0

    def on_speech_end(self) -> None:
        """Called when meditator stops speaking."""
        self._last_speech_end = time.time()
        self._state = ConversationState.PROCESSING
        self._has_spoken = True

    def on_transcription(self, text: str) -> TurnDecision:
        """Process transcribed text and decide on turn-taking.

        If in silence mode, any speech auto-exits it. The LLM decides
        whether to *enter* silence mode via the [HOLD] signal — that
        is handled externally after the LLM response is received.

        Args:
            text: Transcribed speech

        Returns:
            TurnDecision indicating what to do
        """
        if self._silence_mode_start is not None:
            self.exit_silence_mode()

        return TurnDecision.RESPOND

    def should_respond(self) -> TurnDecision:
        """Check if it's time to respond based on timing.

        Call this periodically during silence to check timing-based decisions.

        Returns:
            TurnDecision indicating what to do
        """
        now = time.time()

        # Exponential backoff: e.g. 240s, 480s, 960s, ...
        check_in_threshold = self.config.extended_silence_sec * (2 ** self._check_in_count)

        # If in silence mode, hold indefinitely (no check-ins)
        if self._silence_mode_start is not None:
            return TurnDecision.HOLD

        # Normal mode - check if enough time has passed since speech ended
        if self._last_speech_end > 0:
            silence_duration = now - self._last_speech_end
            response_delay = self.config.response_delay_ms / 1000.0

            if silence_duration >= response_delay:
                return TurnDecision.RESPOND

        # Check for extended silence in normal mode (only after conversation has started)
        if self._has_spoken:
            time_since_response = now - self._last_response_time
            if time_since_response >= check_in_threshold:
                return TurnDecision.CHECK_IN

        return TurnDecision.WAIT

    def on_check_in(self) -> None:
        """Record that a check-in occurred (increases backoff interval)."""
        self._check_in_count += 1

    def on_response_start(self) -> None:
        """Called when facilitator starts responding."""
        self._state = ConversationState.RESPONDING

    def on_response_end(self) -> None:
        """Called when facilitator finishes responding."""
        self._state = ConversationState.LISTENING
        self._last_response_time = time.time()
        self._last_speech_end = 0  # Reset for next turn

    def enter_silence_mode(self) -> None:
        """Enter extended silence mode (called after LLM returns [HOLD])."""
        self._state = ConversationState.SILENT_HOLD
        self._silence_mode_start = time.time()

    def exit_silence_mode(self) -> None:
        """Exit silence mode (called when meditator speaks again)."""
        self._state = ConversationState.LISTENING
        self._silence_mode_start = None

    def get_silence_duration(self) -> float:
        """Get current silence duration in seconds."""
        if self._silence_mode_start:
            return time.time() - self._silence_mode_start
        if self._last_speech_end > 0:
            return time.time() - self._last_speech_end
        return time.time() - self._last_response_time

    def is_in_silence_mode(self) -> bool:
        """Check if in extended silence mode."""
        return self._silence_mode_start is not None

"""Voice Activity Detection (VAD)."""

import time
from dataclasses import dataclass
from enum import Enum, auto

import numpy as np


class SpeechState(Enum):
    """Current state of speech detection."""

    SILENCE = auto()
    SPEECH_STARTED = auto()
    SPEAKING = auto()
    SPEECH_ENDED = auto()


@dataclass
class VADResult:
    """Result from VAD processing."""

    state: SpeechState
    is_speech: bool
    speech_duration: float = 0.0
    silence_duration: float = 0.0
    audio_level: float = 0.0


@dataclass
class VADConfig:
    """Configuration for voice activity detection."""

    # Energy threshold for speech detection (0-1 scale, relative to max)
    energy_threshold: float = 0.02

    # Minimum speech duration to consider valid (seconds)
    min_speech_duration: float = 0.3

    # How long silence before considering speech ended (seconds)
    speech_end_silence: float = 1.5

    # Sensitivity level (0-3, higher = more sensitive)
    sensitivity: int = 2

    # Sample rate for timing calculations
    sample_rate: int = 16000


class VoiceActivityDetector:
    """Detects voice activity in audio streams.

    Uses energy-based detection with hysteresis to avoid
    rapid state changes on quiet speech.
    """

    def __init__(self, config: VADConfig | None = None):
        self.config = config or VADConfig()
        self._adjust_for_sensitivity()

        self._state = SpeechState.SILENCE
        self._speech_start_time: float | None = None
        self._last_speech_time: float = 0
        self._last_process_time: float = time.time()

        # Running statistics for adaptive threshold
        self._noise_floor: float = 0.01
        self._noise_samples: int = 0

    def _adjust_for_sensitivity(self) -> None:
        """Adjust thresholds based on sensitivity setting."""
        # Higher sensitivity = lower threshold
        sensitivity_multipliers = {
            0: 2.0,   # Least sensitive
            1: 1.5,
            2: 1.0,   # Default
            3: 0.6,   # Most sensitive
        }
        multiplier = sensitivity_multipliers.get(self.config.sensitivity, 1.0)
        self.config.energy_threshold *= multiplier

    def _calculate_energy(self, audio: np.ndarray) -> float:
        """Calculate RMS energy of audio chunk."""
        if len(audio) == 0:
            return 0.0

        # Normalize int16 to float
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0

        # RMS energy
        rms = np.sqrt(np.mean(audio**2))
        return float(rms)

    def _update_noise_floor(self, energy: float) -> None:
        """Update running estimate of noise floor during silence."""
        if self._state == SpeechState.SILENCE:
            # Exponential moving average
            alpha = 0.1 if self._noise_samples < 100 else 0.01
            self._noise_floor = (1 - alpha) * self._noise_floor + alpha * energy
            self._noise_samples += 1

    def process(self, audio: np.ndarray) -> VADResult:
        """Process an audio chunk and return VAD result."""
        current_time = time.time()
        energy = self._calculate_energy(audio)

        # Adaptive threshold based on noise floor
        threshold = max(
            self.config.energy_threshold,
            self._noise_floor * 3,  # 3x noise floor
        )

        is_speech = energy > threshold

        # State machine
        if self._state == SpeechState.SILENCE:
            if is_speech:
                self._state = SpeechState.SPEECH_STARTED
                self._speech_start_time = current_time
                self._last_speech_time = current_time
            else:
                self._update_noise_floor(energy)

        elif self._state == SpeechState.SPEECH_STARTED:
            if is_speech:
                self._last_speech_time = current_time
                speech_duration = current_time - self._speech_start_time
                if speech_duration >= self.config.min_speech_duration:
                    self._state = SpeechState.SPEAKING
            else:
                # Very short sound, probably noise
                silence_duration = current_time - self._last_speech_time
                if silence_duration > 0.2:
                    self._state = SpeechState.SILENCE
                    self._speech_start_time = None

        elif self._state == SpeechState.SPEAKING:
            if is_speech:
                self._last_speech_time = current_time
            else:
                silence_duration = current_time - self._last_speech_time
                if silence_duration >= self.config.speech_end_silence:
                    self._state = SpeechState.SPEECH_ENDED

        elif self._state == SpeechState.SPEECH_ENDED:
            # This state is transient - immediately go to SILENCE
            # Caller should capture this transition
            self._state = SpeechState.SILENCE
            self._speech_start_time = None

        # Calculate durations
        speech_duration = 0.0
        silence_duration = 0.0

        if self._speech_start_time is not None:
            speech_duration = current_time - self._speech_start_time

        if not is_speech and self._last_speech_time > 0:
            silence_duration = current_time - self._last_speech_time

        self._last_process_time = current_time

        return VADResult(
            state=self._state,
            is_speech=is_speech,
            speech_duration=speech_duration,
            silence_duration=silence_duration,
            audio_level=energy,
        )

    def reset(self) -> None:
        """Reset VAD state.

        Also resets the adaptive noise floor so that residual TTS audio
        picked up by the mic doesn't permanently inflate the detection
        threshold across multiple exchanges.
        """
        self._state = SpeechState.SILENCE
        self._speech_start_time = None
        self._last_speech_time = 0
        self._noise_floor = 0.01
        self._noise_samples = 0


class WebRTCVAD:
    """Voice Activity Detection using webrtcvad library.

    More accurate than energy-based but requires specific audio format.
    """

    def __init__(self, sensitivity: int = 2, sample_rate: int = 16000):
        try:
            import webrtcvad

            self._vad = webrtcvad.Vad(sensitivity)
        except ImportError:
            raise ImportError("webrtcvad not installed. Run: pip install webrtcvad")

        self.sample_rate = sample_rate
        self._state = SpeechState.SILENCE
        self._speech_start_time: float | None = None
        self._last_speech_time: float = 0

        # Frame duration must be 10, 20, or 30 ms
        self.frame_duration_ms = 30
        self.frame_size = int(sample_rate * self.frame_duration_ms / 1000)

    def process(self, audio: np.ndarray) -> VADResult:
        """Process audio chunk through webrtcvad."""

        current_time = time.time()

        # Ensure correct format
        if audio.dtype != np.int16:
            audio = (audio * 32768).astype(np.int16)

        # webrtcvad needs bytes
        audio_bytes = audio.tobytes()

        # Process in frames
        is_speech = False
        for i in range(0, len(audio_bytes) - self.frame_size * 2, self.frame_size * 2):
            frame = audio_bytes[i : i + self.frame_size * 2]
            if len(frame) == self.frame_size * 2:
                try:
                    if self._vad.is_speech(frame, self.sample_rate):
                        is_speech = True
                        break
                except Exception:
                    pass

        # State machine (same as energy-based)
        if is_speech:
            if self._state == SpeechState.SILENCE:
                self._state = SpeechState.SPEECH_STARTED
                self._speech_start_time = current_time
            elif self._state == SpeechState.SPEECH_STARTED:
                if current_time - self._speech_start_time > 0.3:
                    self._state = SpeechState.SPEAKING
            self._last_speech_time = current_time
        else:
            if self._state in (SpeechState.SPEECH_STARTED, SpeechState.SPEAKING):
                if current_time - self._last_speech_time > 1.5:
                    self._state = SpeechState.SPEECH_ENDED

            if self._state == SpeechState.SPEECH_ENDED:
                self._state = SpeechState.SILENCE
                self._speech_start_time = None

        speech_duration = 0.0
        if self._speech_start_time:
            speech_duration = current_time - self._speech_start_time

        silence_duration = 0.0
        if not is_speech and self._last_speech_time > 0:
            silence_duration = current_time - self._last_speech_time

        return VADResult(
            state=self._state,
            is_speech=is_speech,
            speech_duration=speech_duration,
            silence_duration=silence_duration,
            audio_level=0.0,  # webrtcvad doesn't provide this
        )

    def reset(self) -> None:
        """Reset VAD state."""
        self._state = SpeechState.SILENCE
        self._speech_start_time = None
        self._last_speech_time = 0


def create_vad(
    method: str = "energy",
    sensitivity: int = 2,
    sample_rate: int = 16000,
) -> VoiceActivityDetector | WebRTCVAD:
    """Factory function to create VAD instance."""
    if method == "energy":
        config = VADConfig(sensitivity=sensitivity, sample_rate=sample_rate)
        return VoiceActivityDetector(config)
    elif method == "webrtc":
        return WebRTCVAD(sensitivity=sensitivity, sample_rate=sample_rate)
    else:
        raise ValueError(f"Unknown VAD method: {method}")

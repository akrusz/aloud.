"""Microphone audio capture."""

import asyncio
import logging
import queue
import threading
from dataclasses import dataclass
from typing import AsyncIterator, Callable

import numpy as np
import sounddevice as sd

logger = logging.getLogger(__name__)


@dataclass
class AudioChunk:
    """A chunk of audio data with metadata."""

    data: np.ndarray
    sample_rate: int
    timestamp: float


class AudioInput:
    """Captures audio from the microphone."""

    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        chunk_size: int = 480,  # 30ms at 16kHz
        device: str | int | None = None,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.device = device

        self._audio_queue: queue.Queue[np.ndarray] = queue.Queue()
        self._stream: sd.InputStream | None = None
        self._running = False
        self._start_time: float = 0

    def _audio_callback(
        self,
        indata: np.ndarray,
        frames: int,
        time_info: dict,
        status: sd.CallbackFlags,
    ) -> None:
        """Called by sounddevice for each audio chunk."""
        if status:
            logger.debug("Audio input status: %s", status)
        # Copy the data to avoid buffer issues
        self._audio_queue.put(indata.copy())

    def start(self) -> None:
        """Start capturing audio."""
        if self._running:
            return

        import time

        self._start_time = time.time()
        self._running = True

        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            blocksize=self.chunk_size,
            dtype=np.int16,
            device=self.device,
            callback=self._audio_callback,
        )
        self._stream.start()

    def stop(self) -> None:
        """Stop capturing audio."""
        self._running = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    async def stream(self) -> AsyncIterator[AudioChunk]:
        """Async generator yielding audio chunks."""
        import time

        while self._running:
            try:
                # Non-blocking get with small timeout
                data = self._audio_queue.get(timeout=0.01)
                yield AudioChunk(
                    data=data.flatten(),
                    sample_rate=self.sample_rate,
                    timestamp=time.time() - self._start_time,
                )
            except queue.Empty:
                await asyncio.sleep(0.001)

    def get_chunk_blocking(self, timeout: float = 1.0) -> AudioChunk | None:
        """Get a single audio chunk (blocking)."""
        import time

        try:
            data = self._audio_queue.get(timeout=timeout)
            return AudioChunk(
                data=data.flatten(),
                sample_rate=self.sample_rate,
                timestamp=time.time() - self._start_time,
            )
        except queue.Empty:
            return None

    def clear_buffer(self) -> None:
        """Clear any buffered audio data."""
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
            except queue.Empty:
                break

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
        return False

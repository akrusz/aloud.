"""macOS native text-to-speech using the 'say' command."""

import asyncio
import logging
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


class MacOSTTS:
    """Text-to-speech using macOS 'say' command.

    Zero latency, no API cost, decent quality.
    Available voices include: Samantha, Ava, Alex, Allison, Susan, Tom, etc.
    Enhanced voices (e.g., "Ava (Enhanced)") have better quality.
    """

    def __init__(
        self,
        voice: str = "Samantha",
        rate: int = 180,
    ):
        """Initialize macOS TTS.

        Args:
            voice: Voice name (e.g., "Samantha", "Ava", "Alex")
            rate: Speaking rate in words per minute
        """
        self.voice = voice
        self.rate = rate
        self._process: asyncio.subprocess.Process | None = None
        self._speaking = False

    async def speak(self, text: str) -> None:
        """Speak the given text.

        Args:
            text: Text to speak
        """
        # Stop any current speech
        self.stop()

        if not text.strip():
            return

        self._speaking = True
        try:
            cmd = ["say", "-v", self.voice, "-r", str(self.rate), text]

            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await self._process.wait()
        finally:
            self._speaking = False
            self._process = None

    def speak_sync(self, text: str) -> None:
        """Speak text synchronously (blocking).

        Args:
            text: Text to speak
        """
        if not text.strip():
            return

        cmd = ["say", "-v", self.voice, "-r", str(self.rate), text]
        subprocess.run(cmd, check=True)

    def speak_to_bytes(self, text: str) -> bytes | None:
        """Generate speech as WAV bytes (synchronous, blocking).

        Returns WAV file bytes, or None on failure.
        """
        if not text.strip():
            return None

        tmp = None
        try:
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()

            cmd = [
                "say", "-v", self.voice, "-r", str(self.rate),
                "-o", tmp.name,
                "--file-format=WAVE", "--data-format=LEI16",
                text,
            ]
            subprocess.run(cmd, check=True, capture_output=True)

            wav_bytes = Path(tmp.name).read_bytes()
            return wav_bytes
        except Exception as e:
            logger.error("Error generating audio: %s", e)
            return None
        finally:
            if tmp:
                try:
                    Path(tmp.name).unlink(missing_ok=True)
                except Exception:
                    pass

    def stop(self) -> None:
        """Stop any current speech."""
        if self._process:
            try:
                self._process.terminate()
            except ProcessLookupError:
                pass
            self._process = None
        self._speaking = False

        # Also kill any running say processes
        try:
            subprocess.run(
                ["pkill", "-9", "say"],
                capture_output=True,
            )
        except Exception:
            pass

    def is_speaking(self) -> bool:
        """Check if currently speaking.

        Returns:
            True if currently speaking
        """
        return self._speaking

    def set_voice(self, voice: str) -> None:
        """Set the voice to use.

        Args:
            voice: Voice name
        """
        self.voice = voice

    def set_rate(self, rate: int) -> None:
        """Set the speaking rate.

        Args:
            rate: Words per minute
        """
        self.rate = rate

    @staticmethod
    def list_voices() -> list[dict]:
        """List available voices.

        Returns:
            List of dicts with 'name' and 'lang' keys.
        """
        import re

        result = subprocess.run(
            ["say", "-v", "?"],
            capture_output=True,
            text=True,
        )

        voices = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            # Format: "Voice Name    xx_XX    # description"
            # Voice names can contain spaces and parentheses.
            # Split on the lang code pattern to extract the name.
            m = re.match(r"^(.+?)\s{2,}(\w{2}_\w{2})\s", line)
            if m:
                voices.append({"name": m.group(1).strip(), "lang": m.group(2)})

        return voices

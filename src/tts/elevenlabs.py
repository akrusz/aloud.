"""ElevenLabs TTS engine.

ElevenLabs provides the highest quality neural TTS with natural prosody
and emotion. Ideal for meditation facilitation where voice quality matters.

https://elevenlabs.io/
"""

import os

import httpx


# Recommended voices for meditation facilitation
RECOMMENDED_VOICES = {
    # Calm, warm voices good for meditation
    "rachel": "21m00Tcm4TlvDq8ikWAM",  # Calm, warm female
    "drew": "29vD33N1CtxCmqQRPOHJ",     # Calm male
    "clyde": "2EiwWnXFnvU5JabPnv8n",   # Warm, deep male
    "domi": "AZnzlk1XvdvUeBnXmlld",    # Pleasant female
    "bella": "EXAVITQu4vr4xnSDxMaL",   # Soft female
    "adam": "pNInz6obpgDQGcFmaJgB",    # Natural male
}


class ElevenLabsTTS:
    """Text-to-speech using ElevenLabs API.

    Highest quality option with natural prosody and expressiveness.
    Adds some latency due to API calls, but quality may be worth it
    for meditation facilitation.
    """

    def __init__(
        self,
        api_key: str | None = None,
        voice_id: str | None = None,
        voice_name: str | None = None,
        model_id: str = "eleven_monolingual_v1",
        stability: float = 0.75,  # Higher = more consistent
        similarity_boost: float = 0.75,
        style: float = 0.0,  # 0 = more stable for meditation
        use_speaker_boost: bool = True,
    ):
        """Initialize ElevenLabs TTS.

        Args:
            api_key: ElevenLabs API key (defaults to ELEVENLABS_API_KEY env var)
            voice_id: Voice ID to use (takes precedence over voice_name)
            voice_name: Voice name from RECOMMENDED_VOICES
            model_id: Model to use (eleven_monolingual_v1, eleven_multilingual_v2, etc.)
            stability: Voice stability (0-1, higher = more consistent)
            similarity_boost: Similarity boost (0-1)
            style: Style exaggeration (0-1, 0 = more natural for meditation)
            use_speaker_boost: Enable speaker boost for clarity
        """
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY")

        if not self.api_key:
            raise ValueError(
                "ElevenLabs API key required. Set ELEVENLABS_API_KEY environment "
                "variable or pass api_key parameter."
            )

        # Resolve voice
        if voice_id:
            self.voice_id = voice_id
        elif voice_name and voice_name.lower() in RECOMMENDED_VOICES:
            self.voice_id = RECOMMENDED_VOICES[voice_name.lower()]
        else:
            # Default to Rachel - calm, warm female voice
            self.voice_id = RECOMMENDED_VOICES["rachel"]

        self.model_id = model_id
        self.stability = stability
        self.similarity_boost = similarity_boost
        self.style = style
        self.use_speaker_boost = use_speaker_boost

        self._speaking = False
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=30.0,
                headers={
                    "xi-api-key": self.api_key,
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def speak(self, text: str) -> None:
        """Speak the given text.

        Args:
            text: Text to speak
        """
        if not text.strip():
            return

        self.stop()
        self._speaking = True

        try:
            # Generate audio
            audio_data = await self._synthesize(text)

            # Play audio
            await self._play_audio(audio_data)

        finally:
            self._speaking = False

    async def _synthesize(self, text: str) -> bytes:
        """Synthesize speech from text.

        Args:
            text: Text to synthesize

        Returns:
            Audio data as bytes (raw 16-bit PCM at 22050 Hz)
        """
        client = await self._get_client()

        url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}?output_format=pcm_22050"

        payload = {
            "text": text,
            "model_id": self.model_id,
            "voice_settings": {
                "stability": self.stability,
                "similarity_boost": self.similarity_boost,
                "style": self.style,
                "use_speaker_boost": self.use_speaker_boost,
            },
        }

        response = await client.post(url, json=payload)
        response.raise_for_status()

        return response.content

    async def _play_audio(self, audio_data: bytes) -> None:
        """Play audio data (raw 16-bit PCM at 22050 Hz)."""
        from ..audio.playback import play_audio_bytes

        await play_audio_bytes(audio_data, sample_rate=22050)

    def stop(self) -> None:
        """Stop current speech."""
        from ..audio.playback import stop_playback

        stop_playback()
        self._speaking = False

    def is_speaking(self) -> bool:
        """Check if currently speaking."""
        return self._speaking

    def set_voice(self, voice: str) -> None:
        """Set the voice to use.

        Args:
            voice: Voice name (from RECOMMENDED_VOICES) or voice ID
        """
        if voice.lower() in RECOMMENDED_VOICES:
            self.voice_id = RECOMMENDED_VOICES[voice.lower()]
        else:
            # Assume it's a voice ID
            self.voice_id = voice

    def set_rate(self, rate: int) -> None:
        """Set speaking rate.

        Note: ElevenLabs doesn't directly support rate control.
        This is a no-op for API compatibility.
        """
        pass

    async def list_voices(self) -> list[dict]:
        """List available voices from your ElevenLabs account.

        Returns:
            List of voice information dicts
        """
        client = await self._get_client()

        response = await client.get("https://api.elevenlabs.io/v1/voices")
        response.raise_for_status()

        data = response.json()
        return data.get("voices", [])

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None


class ElevenLabsStreamingTTS(ElevenLabsTTS):
    """Streaming variant of ElevenLabs TTS for lower latency.

    Uses WebSocket streaming to start playing audio before
    the full response is generated.
    """

    async def _synthesize_streaming(self, text: str):
        """Synthesize with streaming for lower latency."""
        # Note: Full implementation would use ElevenLabs WebSocket API
        # For now, fall back to regular synthesis
        # TODO: Implement WebSocket streaming for lower latency
        return await self._synthesize(text)

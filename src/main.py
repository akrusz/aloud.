"""Main entry point and event loop for the somatic meditation facilitator."""

import argparse
import asyncio
import signal
import sys

import numpy as np

from . import __version__
from .config import load_config, Config
from .audio.input import AudioInput
from .audio.vad import VoiceActivityDetector, VADConfig, VADResult, SpeechState
from .stt.whisper_cpp import WhisperCppSTT
from .tts import create_tts
from .llm.ollama import create_llm_provider
from .llm.base import Message
from .facilitation.pacing import PacingController, TurnDecision
from .facilitation.prompts import PromptBuilder, PromptConfig, parse_hold_signal
from .facilitation.session import SessionManager
from .log_config import configure_logging
from .logging.transcript import TranscriptLogger


class MeditationFacilitator:
    """Main application class that orchestrates all components."""

    def __init__(self, config: Config):
        self.config = config

        # Initialize components
        self._init_audio()
        self._init_stt()
        self._init_tts()
        self._init_llm()
        self._init_facilitation()
        self._init_logging()

        # State
        self._running = False
        self._audio_buffer: list[np.ndarray] = []
        self._interrupted = False

    def _init_audio(self) -> None:
        """Initialize audio components."""
        self.audio_input = AudioInput(
            sample_rate=self.config.audio.sample_rate,
            channels=self.config.audio.channels,
            chunk_size=self.config.audio.chunk_size,
            device=self.config.audio.input_device if self.config.audio.input_device != "default" else None,
        )

        vad_config = VADConfig(
            sensitivity=self.config.audio.vad_sensitivity,
            sample_rate=self.config.audio.sample_rate,
            min_speech_duration=self.config.pacing.min_speech_duration_ms / 1000.0,
            speech_end_silence=self.config.pacing.response_delay_ms / 1000.0,
        )
        self.vad = VoiceActivityDetector(vad_config)

    def _init_stt(self) -> None:
        """Initialize speech-to-text."""
        self.stt = WhisperCppSTT(
            model=self.config.stt.model,
            language=self.config.stt.language,
        )

    def _init_tts(self) -> None:
        """Initialize text-to-speech."""
        self.tts = create_tts(
            engine=self.config.tts.engine,
            voice=self.config.tts.voice,
            rate=self.config.tts.rate,
            # Parakeet options
            model_name=self.config.tts.model_name,
            backend=self.config.tts.backend,
            device=self.config.tts.device,
            # ElevenLabs options
            api_key=self.config.tts.api_key,
            voice_id=self.config.tts.voice_id,
            model_id=self.config.tts.model_id,
            stability=self.config.tts.stability,
            similarity_boost=self.config.tts.similarity_boost,
        )

    def _init_llm(self) -> None:
        """Initialize LLM provider."""
        model = self.config.llm.effective_model
        self.llm = create_llm_provider(
            provider=self.config.llm.provider,
            model=model,
            proxy_url=self.config.llm.proxy_url,
            ollama_url=self.config.llm.ollama_url,
            api_key=self.config.llm.api_key,
            max_tokens=self.config.llm.max_tokens,
        )

    def _init_facilitation(self) -> None:
        """Initialize facilitation components."""
        self.pacing = PacingController(self.config.pacing)

        prompt_config = PromptConfig(
            focuses=self.config.facilitation.focuses,
            qualities=self.config.facilitation.qualities,
            directiveness=self.config.facilitation.directiveness,
            verbosity=self.config.facilitation.verbosity,
            custom_instructions=self.config.facilitation.custom_instructions,
        )
        self.prompts = PromptBuilder(prompt_config)

        self.session = SessionManager(
            context_strategy=self.config.llm.context_strategy,
            window_size=self.config.llm.window_size,
        )

    def _init_logging(self) -> None:
        """Initialize session logging."""
        self.logger = TranscriptLogger(
            save_directory=self.config.session.save_directory,
            include_timestamps=self.config.session.include_timestamps,
        )

    async def run(self) -> None:
        """Run the main event loop."""
        self._running = True

        # Set up signal handlers (not available on Windows)
        if sys.platform != "win32":
            loop = asyncio.get_event_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, self._handle_interrupt)

        print("\n" + "=" * 60)
        print("  Somatic Exploration Meditation Facilitator")
        print("=" * 60)

        # Pre-load Whisper model before session starts
        self.stt._load_model()

        # Start session
        self.session.start_session()
        self.pacing.start_session()

        # Start audio input
        self.audio_input.start()
        print("Listening... (Ctrl+C to end session)\n")

        # Opening — LLM-generated, with static fallback
        opener = await self._generate_opener()
        print(f"\nFacilitator: {opener}")
        await self.tts.speak(opener)
        self.audio_input.clear_buffer()
        self.vad.reset()
        self._audio_buffer = []
        self.pacing.on_response_end()

        try:
            await self._main_loop()
        finally:
            await self._cleanup()

    async def _main_loop(self) -> None:
        """Main processing loop."""
        # Rolling pre-buffer: keeps recent chunks so speech onset isn't lost
        pre_buffer = []
        PRE_BUFFER_SIZE = 20  # ~600ms at 30ms chunks
        prev_vad_state = SpeechState.SILENCE

        while self._running and not self._interrupted:
            # Get audio chunk
            chunk = self.audio_input.get_chunk_blocking(timeout=0.1)

            if chunk is None:
                # Check for timing-based decisions during silence
                decision = self.pacing.should_respond()
                if decision == TurnDecision.CHECK_IN:
                    await self._do_check_in()
                continue

            # Process through VAD
            vad_result = self.vad.process(chunk.data)

            # Only seed the audio buffer on the *transition* into
            # SPEECH_STARTED — not on every chunk while in that state.
            # The old code ran this on every chunk, wiping the buffer
            # each time and losing ~500ms of speech onset.
            if (vad_result.state == SpeechState.SPEECH_STARTED
                    and prev_vad_state != SpeechState.SPEECH_STARTED):
                self.pacing.on_speech_start()
                self._audio_buffer = list(pre_buffer)
                pre_buffer = []

            # Accumulate audio during any speech-related state
            if vad_result.state in (SpeechState.SPEECH_STARTED, SpeechState.SPEAKING):
                self._audio_buffer.append(chunk.data)
            elif self._state_is_idle(vad_result):
                # Maintain rolling pre-buffer during silence
                pre_buffer.append(chunk.data)
                if len(pre_buffer) > PRE_BUFFER_SIZE:
                    pre_buffer.pop(0)

            if vad_result.state == SpeechState.SPEECH_ENDED:
                self.pacing.on_speech_end()

                if self._audio_buffer:
                    # Transcribe collected audio
                    audio_data = np.concatenate(self._audio_buffer)
                    self._audio_buffer = []

                    transcription = self.stt.transcribe(
                        audio_data,
                        sample_rate=self.config.audio.sample_rate,
                    )

                    if transcription.text.strip():
                        print(f"\nMeditator: {transcription.text}")
                        self.session.add_user_message(transcription.text)

                        # Any speech auto-exits silence mode; always respond
                        self.pacing.on_transcription(transcription.text)
                        await self._generate_response()

            prev_vad_state = vad_result.state
            await asyncio.sleep(0.01)

    @staticmethod
    def _state_is_idle(vad_result: VADResult) -> bool:
        """Check if VAD is in an idle/silence state (safe to buffer)."""
        return vad_result.state in (SpeechState.SILENCE, SpeechState.SPEECH_ENDED)

    async def _generate_opener(self) -> str:
        """Generate an LLM-powered session opening, with static fallback."""
        try:
            opener_prompt = self.prompts.build_opener_prompt()
            self.session.add_user_message(opener_prompt)

            messages = self.session.get_context_messages()
            llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]

            result = await self.llm.complete(
                messages=llm_messages,
                system=self.prompts.build_system_prompt(),
            )
            response = result.text.strip()

            # Clean up: remove the fake user prompt, keep the response
            if self.session.state and self.session.state.exchanges:
                self.session.state.exchanges.pop(-1)  # remove opener_prompt

            self.session.add_assistant_message(response)
            return response
        except Exception as e:
            print(f"\n(LLM opener failed: {e}, using static fallback)")
            # Clean up any partial state from the failed attempt
            if (self.session.state and self.session.state.exchanges
                    and self.session.state.exchanges[-1].role == "user"):
                self.session.state.exchanges.pop()

            opener = self.prompts.get_session_opener()
            self.session.add_assistant_message(opener)
            return opener

    async def _generate_response(self) -> None:
        """Generate and speak a facilitator response."""
        self.pacing.on_response_start()

        # Get conversation context
        messages = self.session.get_context_messages()
        llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]

        # Generate response
        try:
            result = await self.llm.complete(
                messages=llm_messages,
                system=self.prompts.build_system_prompt(),
            )
            response = result.text.strip()
        except Exception as e:
            print(f"\n(LLM error: {e})")
            response = "What do you notice now?"

        # Check for [HOLD] signal — LLM wants us to enter silence mode
        hold_signal, clean_response = parse_hold_signal(response)

        if clean_response:
            print(f"\nFacilitator: {clean_response}")
            # Keep [HOLD] prefix in history so the LLM has context
            self.session.add_assistant_message(response if hold_signal == "hold" else clean_response)
            # Skip TTS for non-speakable responses (e.g. "." used as silence marker in Open style)
            if any(c.isalpha() or c.isdigit() for c in clean_response):
                await self.tts.speak(clean_response)
                # Clear mic buffer and reset VAD so we don't process TTS audio as speech
                self.audio_input.clear_buffer()
                self.vad.reset()
                self._audio_buffer = []

        if hold_signal == "hold":
            self.pacing.enter_silence_mode()

        self.pacing.on_response_end()

    async def _do_check_in(self) -> None:
        """Do a gentle check-in after extended silence."""
        check_in = self.prompts.get_check_in_prompt()
        print(f"\nFacilitator: {check_in}")
        await self.tts.speak(check_in)
        self.audio_input.clear_buffer()
        self.vad.reset()
        self._audio_buffer = []
        self.session.add_assistant_message(check_in)
        self.pacing.on_check_in()
        self.pacing.on_response_end()

    def _handle_interrupt(self) -> None:
        """Handle interrupt signal."""
        print("\n\nEnding session...")
        self._interrupted = True
        self._running = False

    async def _cleanup(self) -> None:
        """Clean up resources and save session."""
        self.audio_input.stop()
        self.tts.stop()

        self.pacing.end_session()

        # Save session
        session_state = self.session.end_session()
        if session_state and self.config.session.auto_save:
            session_data = self.session.to_dict()
            if session_data:
                # Save both formats
                json_path = self.logger.save_session(session_data)
                self.logger.save_session_text(session_data)
                print(f"\nSession saved to: {json_path}")

        print("\nSession ended. Be well.\n")


def list_sessions(config: Config) -> None:
    """List all saved sessions."""
    logger = TranscriptLogger(save_directory=config.session.save_directory)
    sessions = logger.list_sessions()

    if not sessions:
        print("No saved sessions found.")
        return

    print("\nSaved Sessions:")
    print("-" * 60)

    for session in sessions:
        duration = session.get("duration")
        if duration:
            minutes = int(duration // 60)
            seconds = int(duration % 60)
            duration_str = f"{minutes}m {seconds}s"
        else:
            duration_str = "unknown"

        exchanges = session.get("exchange_count", 0)
        tags = ", ".join(session.get("tags", [])) or "none"

        print(f"  {session['session_id']}")
        print(f"    Duration: {duration_str}, Exchanges: {exchanges}")
        print(f"    Tags: {tags}")
        print()


def view_session(session_id: str, config: Config) -> None:
    """View a specific session."""
    logger = TranscriptLogger(save_directory=config.session.save_directory)
    session = logger.load_session(session_id)

    if not session:
        print(f"Session not found: {session_id}")
        return

    # Print formatted transcript
    print("\n" + "=" * 60)
    print(f"  Session: {session_id}")
    print("=" * 60)
    print()

    for exchange in session.get("exchanges", []):
        role = exchange["role"].capitalize()
        content = exchange["content"]
        timestamp = exchange.get("time", "")

        if timestamp:
            time_part = timestamp.split("T")[1].split(".")[0] if "T" in timestamp else timestamp
            print(f"[{time_part}] {role}: {content}")
        else:
            print(f"{role}: {content}")
        print()


def main():
    """Main entry point."""
    configure_logging()
    parser = argparse.ArgumentParser(
        description="Somatic Exploration Meditation Facilitator"
    )
    parser.add_argument(
        "--config", "-c",
        type=str,
        help="Path to configuration file",
    )
    parser.add_argument(
        "--list-sessions",
        action="store_true",
        help="List all saved sessions",
    )
    parser.add_argument(
        "--view-session",
        type=str,
        metavar="SESSION_ID",
        help="View a specific session transcript",
    )
    parser.add_argument(
        "--check-update",
        action="store_true",
        help="Check if a new version is available",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Update glooow to the latest version",
    )

    args = parser.parse_args()

    # Handle update commands (no config/audio needed)
    if args.check_update:
        from .updater import check_for_updates
        print(f"glooow v{__version__}")
        status = check_for_updates(force=True)
        if status.error:
            print(f"Error: {status.error}")
        elif status.available:
            print(f"Update available! ({status.commits_behind} commit(s) behind)")
            for msg in status.commit_messages:
                print(f"  - {msg}")
        else:
            print("You're up to date.")
        return

    if args.update:
        from .updater import apply_update
        print(f"glooow v{__version__} — updating...")
        result = apply_update()
        print(result.message)
        return

    # Load configuration
    config = load_config(args.config)

    # Handle list/view commands
    if args.list_sessions:
        list_sessions(config)
        return

    if args.view_session:
        view_session(args.view_session, config)
        return

    # Run the facilitator
    facilitator = MeditationFacilitator(config)

    try:
        asyncio.run(facilitator.run())
    except KeyboardInterrupt:
        print("\nSession interrupted.")


if __name__ == "__main__":
    main()

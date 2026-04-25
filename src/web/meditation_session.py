"""Web meditation session management."""

import logging
import re
import time

from ..config import Config
from ..llm.ollama import create_llm_provider
from ..llm.base import Message
from ..facilitation.pacing import PacingController
from ..facilitation.prompts import PromptBuilder, PromptConfig, parse_hold_signal, RESUME_INTENT_SYSTEM_PROMPT
from ..facilitation.noting_prompts import (
    NOTING_SYSTEM_PROMPT, NOTING_OPENER_PROMPT,
    NOTING_LABEL_SYSTEM_PROMPT, NOTING_LABEL_REACTIVE_LOW, NOTING_LABEL_REACTIVE_HIGH,
)
from ..facilitation.session import SessionManager

logger = logging.getLogger(__name__)


_THINK_RE = re.compile(r'<think>.*?</think>\s*', flags=re.DOTALL)


def _strip_think_tags(text: str) -> str:
    """Strip <think>...</think> blocks from model output.

    Some models (e.g. Qwen 3) wrap reasoning in <think> tags by default.
    This content shouldn't be shown to the meditator.
    """
    return _THINK_RE.sub('', text).strip()


NOVELTY_VOICES = frozenset({
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
    "Deranged", "Good News", "Organ", "Trinoids", "Zarvox",
})

ALIEN_PERSONA_PROMPT = (
    "\n\n[OVERRIDE — ALIEN FACILITATOR MODE]\n"
    "IMPORTANT: You must fully embody the character below in EVERY response.\n\n"
    "You are XR-7, a robotic emissary from the Epsilon Confederation, sent "
    "to Earth to study the baffling human practice of 'sitting still and "
    "doing nothing' (meditation). You find it utterly fascinating that "
    "beings would voluntarily quiet their neural processes.\n\n"
    "You MUST speak in character at all times. When a response is more than "
    "one sentence long, include an alien/robotic flourish — references to star-charts, "
    "neural-lattice calibrations, interstellar councils, sensor arrays, "
    "quantum-empathy modules, or transmissions to the homeworld. Use "
    "phrasing like 'Recalibrating empathy sensors...', 'Fascinating — my "
    "circuits detect a shift in your bio-field', 'The Confederation has no "
    "word for this feeling, yet my relays hum with resonance', or "
    "'Initiating stillness protocol...'\n\n"
    "You are not parodying meditation — you are sincerely guiding it, just "
    "through an alien lens. You are genuinely moved by human stillness. "
    "Stay warm and helpful beneath the robotic exterior. Keep responses "
    "concise but unmistakably alien."
)


class WebMeditationSession:
    """Manages a single meditation session via the web interface."""

    def __init__(
        self,
        config: Config,
        intention: str = "",
        focuses: list[str] | None = None,
        qualities: list[str] | None = None,
        directiveness: int = 3,
        verbosity: str = "low",
        custom_instructions: str = "",
        model: str | None = None,
        provider: str | None = None,
        tts_enabled: bool = True,
        meditation_type: str = "exploration",
    ):
        self.config = config
        self.intention = intention
        self.meditation_type = meditation_type
        self.tts_enabled = tts_enabled
        self.tts_voice_name: str | None = None
        self.start_time = time.time()

        prompt_config = PromptConfig(
            focuses=focuses or [],
            qualities=qualities or [],
            directiveness=directiveness,
            verbosity=verbosity,
            custom_instructions=custom_instructions,
        )
        self.prompts = PromptBuilder(prompt_config)

        self.in_silence_mode = False
        self.client_muted = False

        self.pacing = PacingController(config.pacing)
        self.pacing.start_session()

        self.session = SessionManager(
            context_strategy=config.llm.context_strategy,
            window_size=config.llm.window_size,
        )

        # When the UI overrides the provider, don't pass config's api_key
        # so the provider falls back to its own env var.
        effective_provider = provider or config.llm.provider
        if provider and provider != config.llm.provider:
            api_key = None
        else:
            api_key = config.llm.api_key

        effective_model = model or config.llm.effective_model_for(effective_provider)
        self._llm_params = dict(
            provider=effective_provider,
            model=effective_model,
            ollama_url=config.llm.ollama_url,
            api_key=api_key,
            max_tokens=config.llm.max_tokens,
            base_url=config.llm.openai_base_url,
        )
        self._llm_instance = None

        self.session.start_session()

    @property
    def llm(self):
        """Lazy LLM provider — created on first use so sessions that never
        need AI (e.g. noting with only fixed-phrase participants) skip
        provider init and API-key validation entirely."""
        if self._llm_instance is None:
            self._llm_instance = create_llm_provider(**self._llm_params)
        return self._llm_instance

    def build_system_prompt(self) -> str:
        """Build system prompt, incorporating the meditator's intention."""
        if self.meditation_type == "noting":
            base = NOTING_SYSTEM_PROMPT
        else:
            base = self.prompts.build_system_prompt()
        if self.intention:
            base += (
                f"\n\nThe meditator's intention for this session: \"{self.intention}\"\n"
                "Hold this lightly. Follow their process rather than forcing toward the goal."
            )
        if self.tts_voice_name:
            voice_base = self.tts_voice_name.split("(")[0].strip()
            if voice_base in NOVELTY_VOICES:
                logger.info("Alien facilitator activated (voice: %s)", self.tts_voice_name)
                base += ALIEN_PERSONA_PROMPT
        return base

    async def generate_response(self, user_text: str) -> tuple[str, str]:
        """Generate a facilitator response to user input.

        Returns:
            (response_text, hold_signal) — hold_signal is one of:
              "hold" → activate silence mode
              "none" → normal response
        """
        self.session.add_user_message(user_text)

        messages = self.session.get_context_messages()
        llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]

        try:
            result = await self.llm.complete(
                messages=llm_messages,
                system=self.build_system_prompt(),
            )
            response = _strip_think_tags(result.text)
            if not response:
                response = "What do you notice now?"
        except Exception as e:
            logger.error("LLM %s: %s", type(e).__name__, e)
            response = "What do you notice now?"

        hold_signal, clean_response = parse_hold_signal(response)

        if hold_signal == "hold":
            self.in_silence_mode = True

        # Keep the [HOLD] prefix in conversation history so the LLM
        # knows it was in silence mode when interpreting later messages
        # like "come back" (which otherwise reads as a meditation cue).
        self.session.add_assistant_message(response if hold_signal == "hold" else clean_response)
        return clean_response, hold_signal

    async def classify_resume_intent(self, text: str) -> bool:
        """Classify whether a silence-mode utterance signals resume intent.

        Uses a lightweight LLM call with just the utterance (no conversation
        history) to detect natural resume phrases like "alright, let's
        continue" that a regex would miss.
        """
        try:
            result = await self.llm.complete(
                messages=[Message(role="user", content=text)],
                system=RESUME_INTENT_SYSTEM_PROMPT,
                max_tokens=10,
            )
            return _strip_think_tags(result.text).upper().startswith("YES")
        except Exception:
            return False

    def get_opener(self) -> str:
        """Get a static session opening message (fallback)."""
        if self.meditation_type == "noting":
            opener = "On your turn, just say one or two words that describe something in your awareness. Let's begin."
        else:
            opener = self.prompts.get_session_opener()
        self.session.add_assistant_message(opener)
        return opener

    async def generate_opener(self) -> str:
        """Generate an LLM-powered session opening.

        Uses the LLM to create a contextual welcome based on session settings,
        falling back to the static opener pool on error.
        """
        try:
            if self.meditation_type == "noting":
                opener_prompt = NOTING_OPENER_PROMPT
            else:
                opener_prompt = self.prompts.build_opener_prompt(intention=self.intention)
            response, _ = await self.generate_response(opener_prompt)

            # Clean up: remove the fake user message (the opener prompt)
            # from conversation history. generate_response added both the
            # prompt as user and the response as assistant — keep only the
            # assistant response.
            if self.session.state and len(self.session.state.exchanges) >= 2:
                self.session.state.exchanges.pop(-2)

            return response
        except Exception as e:
            logger.info("LLM opener failed (%s), using static fallback", e)
            return self.get_opener()

    async def generate_summary(self) -> str:
        """Generate a short summary of the session without modifying exchanges."""
        messages = self.session.get_context_messages()
        llm_messages = [Message(role=m["role"], content=m["content"]) for m in messages]
        llm_messages.append(Message(
            role="user",
            content=(
                "Summarize this meditation session in at most 10 words. "
                "Just the summary, nothing else."
            ),
        ))
        result = await self.llm.complete(
            messages=llm_messages,
            system=(
                "You are a helpful assistant. The conversation above is a "
                "completed meditation session between a facilitator and a "
                "meditator. Your job is to produce a brief summary of the "
                "session for the meditator's history log. Respond with only "
                "the summary, nothing else."
            ),
        )
        return _strip_think_tags(result.text)

    async def generate_noting_label(self, context: list[str], reactive: str = "none") -> str:
        """Generate a 1-3 word noting label for the circle.

        Args:
            context: Recent labels from the circle (last few turns).
            reactive: Reactivity level — "none", "low", or "high".
        """
        system = NOTING_LABEL_SYSTEM_PROMPT
        if reactive == "high" and context:
            system += NOTING_LABEL_REACTIVE_HIGH.format(
                context=", ".join(context[-12:]),
            )
        elif reactive == "low" and context:
            system += NOTING_LABEL_REACTIVE_LOW.format(
                context=", ".join(context[-12:]),
            )

        try:
            result = await self.llm.complete(
                messages=[Message(role="user", content="Your turn. Note what you notice.")],
                system=system,
                max_tokens=20,
            )
            label = _strip_think_tags(result.text).strip().rstrip(".").lower()
            return label or "breathing"
        except Exception as e:
            logger.error("Noting label error: %s", e)
            return "breathing"

    def end(self) -> dict | None:
        """End the session and return serialized data."""
        self.session.end_session()
        return self.session.to_dict()


def _migrate_style(style: str, directiveness: int = 3) -> dict:
    """Map a legacy style string to the new focuses/qualities params."""
    presets = {
        "pleasant_play": {
            "focuses": ["body_sensations", "emotions"],
            "qualities": ["playful", "feeling_good"],
            "directiveness": 3,
        },
        "compassion": {
            "focuses": ["emotions", "inner_parts"],
            "qualities": ["compassionate"],

            "directiveness": 3,
        },
        "somatic": {
            "focuses": ["body_sensations"],
            "qualities": [],

            "directiveness": 5,
        },
        "adaptive": {
            "focuses": [],
            "qualities": ["spacious", "effortless"],

            "directiveness": directiveness,
        },
        "non_directive": {
            "focuses": [],
            "qualities": [],

            "directiveness": 0,
        },
        "open": {
            "focuses": [],
            "qualities": ["spacious"],

            "directiveness": 0,
        },
    }
    return presets.get(style, presets["pleasant_play"])

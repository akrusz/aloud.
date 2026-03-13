"""Tests for prompt building and hold signal parsing."""


from src.facilitation.prompts import (
    CHECK_IN_PROMPTS,
    PromptBuilder,
    PromptConfig,
    parse_hold_signal,
)


class TestParseHoldSignal:
    def test_hold_prefix(self):
        signal, text = parse_hold_signal("[HOLD] I'll be right here.")
        assert signal == "hold"
        assert text == "I'll be right here."

    def test_hold_prefix_case_insensitive(self):
        signal, text = parse_hold_signal("[hold] sure thing")
        assert signal == "hold"
        assert text == "sure thing"

    def test_no_hold(self):
        signal, text = parse_hold_signal("What do you notice?")
        assert signal == "none"
        assert text == "What do you notice?"

    def test_hold_with_whitespace(self):
        signal, text = parse_hold_signal("  [HOLD]   Taking space.  ")
        assert signal == "hold"
        assert text == "Taking space."

    def test_empty_after_hold(self):
        signal, text = parse_hold_signal("[HOLD]")
        assert signal == "hold"
        assert text == ""

    def test_hold_not_at_start(self):
        signal, text = parse_hold_signal("Sure. [HOLD] I'll wait.")
        assert signal == "none"
        assert text == "Sure. [HOLD] I'll wait."


class TestPromptBuilder:
    def test_default_includes_base_prompt(self, prompt_builder):
        prompt = prompt_builder.build_system_prompt()
        assert "meditation facilitator" in prompt

    def test_default_includes_open_awareness(self, prompt_builder):
        prompt = prompt_builder.build_system_prompt()
        assert "Whatever arises" in prompt

    def test_focus_added(self):
        builder = PromptBuilder(PromptConfig(focuses=["body_sensations"]))
        prompt = builder.build_system_prompt()
        assert "Body & sensations" in prompt
        # Should not include open_awareness when explicit focus selected
        assert "Whatever arises" not in prompt

    def test_multiple_focuses(self):
        builder = PromptBuilder(PromptConfig(focuses=["body_sensations", "emotions"]))
        prompt = builder.build_system_prompt()
        assert "Body & sensations" in prompt
        assert "Emotions & feeling tone" in prompt

    def test_quality_added(self):
        builder = PromptBuilder(PromptConfig(qualities=["playful"]))
        prompt = builder.build_system_prompt()
        assert "Playful & light" in prompt

    def test_multiple_qualities(self):
        builder = PromptBuilder(PromptConfig(qualities=["compassionate", "spacious"]))
        prompt = builder.build_system_prompt()
        assert "Compassionate" in prompt
        assert "Spacious" in prompt

    def test_directiveness_level(self):
        builder = PromptBuilder(PromptConfig(directiveness=0))
        prompt = builder.build_system_prompt()
        assert "extremely non-directive" in prompt

    def test_directiveness_nearest_match(self):
        # directiveness=4 should match key 3 or 5 (whichever is nearer)
        builder = PromptBuilder(PromptConfig(directiveness=4))
        prompt = builder.build_system_prompt()
        assert "Gently curious" in prompt or "Balanced" in prompt

    def test_verbosity_low(self):
        builder = PromptBuilder(PromptConfig(verbosity="low"))
        prompt = builder.build_system_prompt()
        assert "very brief" in prompt

    def test_verbosity_high(self):
        builder = PromptBuilder(PromptConfig(verbosity="high"))
        prompt = builder.build_system_prompt()
        assert "longer reflections" in prompt

    def test_custom_instructions(self):
        builder = PromptBuilder(PromptConfig(custom_instructions="Speak in haiku."))
        prompt = builder.build_system_prompt()
        assert "Speak in haiku." in prompt

    def test_unknown_focus_ignored(self):
        builder = PromptBuilder(PromptConfig(focuses=["nonexistent"]))
        prompt = builder.build_system_prompt()
        # Should still have base prompt
        assert "meditation facilitator" in prompt


class TestSessionOpener:
    def test_opener_returns_string(self, prompt_builder):
        opener = prompt_builder.get_session_opener()
        assert isinstance(opener, str)
        assert len(opener) > 0

    def test_low_directiveness_gives_minimal_opener(self):
        builder = PromptBuilder(PromptConfig(directiveness=0))
        opener = builder.get_session_opener()
        # Should be from _MINIMAL_OPENERS
        assert opener in [
            "I'm here.",
            "Take your time.",
            "Whenever you're ready.",
            "I'm here whenever you're ready.",
        ]


class TestOpenerPrompt:
    def test_opener_prompt_includes_instruction(self, prompt_builder):
        prompt = prompt_builder.build_opener_prompt()
        assert "opening" in prompt.lower()

    def test_opener_prompt_includes_intention(self):
        builder = PromptBuilder()
        prompt = builder.build_opener_prompt(intention="find calm")
        assert "find calm" in prompt

    def test_opener_prompt_includes_focuses(self):
        builder = PromptBuilder(PromptConfig(focuses=["emotions"]))
        prompt = builder.build_opener_prompt()
        assert "emotions" in prompt

    def test_opener_prompt_low_directiveness(self):
        builder = PromptBuilder(PromptConfig(directiveness=1))
        prompt = builder.build_opener_prompt()
        assert "minimal" in prompt.lower()

    def test_opener_prompt_high_directiveness(self):
        builder = PromptBuilder(PromptConfig(directiveness=8))
        prompt = builder.build_opener_prompt()
        assert "suggest" in prompt.lower()


class TestCheckInPrompt:
    def test_check_in_returns_known_prompt(self, prompt_builder):
        prompt = prompt_builder.get_check_in_prompt()
        assert prompt in CHECK_IN_PROMPTS

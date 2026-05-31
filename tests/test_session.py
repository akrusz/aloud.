"""Tests for session state management."""

import time

import pytest

from src.facilitation.session import Exchange, SessionState


class TestExchange:
    def test_to_dict(self):
        ex = Exchange(role="user", content="hello", timestamp=1000000.0)
        d = ex.to_dict()
        assert d["role"] == "user"
        assert d["content"] == "hello"
        assert d["timestamp"] == 1000000.0
        assert "time" in d  # ISO formatted time


class TestSessionState:
    def test_duration(self):
        state = SessionState(start_time=time.time() - 10)
        assert state.duration >= 9.5

    def test_duration_with_end_time(self):
        state = SessionState(start_time=100, end_time=200)
        assert state.duration == 100

    def test_exchange_count(self):
        state = SessionState()
        assert state.exchange_count == 0
        state.exchanges.append(Exchange(role="user", content="hi"))
        assert state.exchange_count == 1


class TestSessionManager:
    def test_start_and_end_session(self, session_manager):
        state = session_manager.start_session("test-id")
        assert session_manager.is_active
        assert state.session_id == "test-id"

        result = session_manager.end_session()
        assert result is not None
        assert result.end_time is not None
        assert not session_manager.is_active

    def test_auto_generates_session_id(self, session_manager):
        state = session_manager.start_session()
        assert len(state.session_id) > 0

    def test_end_session_without_start(self, session_manager):
        result = session_manager.end_session()
        assert result is None

    def test_add_user_message(self, session_manager):
        session_manager.start_session()
        session_manager.add_user_message("I feel tension")
        assert len(session_manager.state.exchanges) == 1
        assert session_manager.state.exchanges[0].role == "user"
        assert session_manager.state.exchanges[0].content == "I feel tension"

    def test_add_assistant_message(self, session_manager):
        session_manager.start_session()
        session_manager.add_assistant_message("What's that like?")
        assert session_manager.state.exchanges[0].role == "assistant"

    def test_add_message_without_session_raises(self, session_manager):
        with pytest.raises(RuntimeError, match="No active session"):
            session_manager.add_user_message("hello")

    def test_get_last_user_message(self, session_manager):
        session_manager.start_session()
        session_manager.add_user_message("first")
        session_manager.add_assistant_message("response")
        session_manager.add_user_message("second")
        assert session_manager.get_last_user_message() == "second"

    def test_get_last_user_message_none(self, session_manager):
        session_manager.start_session()
        assert session_manager.get_last_user_message() is None

    def test_get_last_user_message_no_session(self, session_manager):
        assert session_manager.get_last_user_message() is None


class TestContextStrategies:
    def test_full_context(self, session_manager):
        session_manager.start_session()
        for i in range(20):
            session_manager.add_user_message(f"msg {i}")
        messages = session_manager.get_context_messages()
        assert len(messages) == 20

    def test_rolling_context(self, rolling_session_manager):
        rolling_session_manager.start_session()
        for i in range(10):
            rolling_session_manager.add_user_message(f"msg {i}")
        messages = rolling_session_manager.get_context_messages()
        assert len(messages) == 3
        assert messages[0]["content"] == "msg 7"
        assert messages[-1]["content"] == "msg 9"

    def test_context_format(self, session_manager):
        session_manager.start_session()
        session_manager.add_user_message("hello")
        session_manager.add_assistant_message("hi")
        messages = session_manager.get_context_messages()
        assert messages == [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]

    def test_context_no_session(self, session_manager):
        assert session_manager.get_context_messages() == []


class TestLoadExchanges:
    def test_load_exchanges(self, session_manager):
        session_manager.start_session()
        exchanges = [
            {"role": "user", "content": "previous msg", "timestamp": 1000},
            {"role": "assistant", "content": "previous response", "timestamp": 1001},
        ]
        session_manager.load_exchanges(exchanges)
        assert len(session_manager.state.exchanges) == 2
        assert session_manager.state.exchanges[0].content == "previous msg"
        assert session_manager.state.exchanges[0].timestamp == 1000

    def test_load_exchanges_without_timestamp(self, session_manager):
        session_manager.start_session()
        session_manager.load_exchanges([{"role": "user", "content": "hi"}])
        assert session_manager.state.exchanges[0].timestamp == 0

    def test_load_exchanges_no_session_raises(self, session_manager):
        with pytest.raises(RuntimeError, match="No active session"):
            session_manager.load_exchanges([{"role": "user", "content": "hi"}])


class TestTagsAndNotes:
    def test_add_tag(self, session_manager):
        session_manager.start_session()
        session_manager.add_tag("body")
        session_manager.add_tag("emotions")
        assert session_manager.state.tags == ["body", "emotions"]

    def test_duplicate_tag_ignored(self, session_manager):
        session_manager.start_session()
        session_manager.add_tag("body")
        session_manager.add_tag("body")
        assert session_manager.state.tags == ["body"]

    def test_set_notes(self, session_manager):
        session_manager.start_session()
        session_manager.set_notes("great session")
        assert session_manager.state.notes == "great session"


class TestSerialization:
    def test_to_dict(self, session_manager):
        session_manager.start_session("test-123")
        session_manager.add_user_message("hello")
        session_manager.add_assistant_message("hi")
        d = session_manager.to_dict()
        assert d["session_id"] == "test-123"
        assert d["exchange_count"] == 2
        assert len(d["exchanges"]) == 2
        assert d["end_time"] is None

    def test_to_dict_no_session(self, session_manager):
        assert session_manager.to_dict() is None


class TestUsageTracking:
    def test_user_exchange_has_no_token_fields(self, session_manager):
        session_manager.start_session()
        session_manager.add_user_message("hello")
        d = session_manager.to_dict()["exchanges"][0]
        assert "tokens_in" not in d and "tokens_out" not in d

    def test_static_assistant_message_has_no_token_fields(self, session_manager):
        session_manager.start_session()
        session_manager.add_assistant_message("welcome back")  # no LLM call
        d = session_manager.to_dict()["exchanges"][0]
        assert "tokens_in" not in d
        assert session_manager.state.usage.llm_calls == 0

    def test_assistant_message_records_per_turn_and_session_usage(self, session_manager):
        session_manager.start_session()
        session_manager.add_assistant_message(
            "what do you notice?", tokens_in=1200, tokens_out=18, cache_read=900
        )
        ex = session_manager.to_dict()["exchanges"][0]
        assert ex["tokens_in"] == 1200
        assert ex["tokens_out"] == 18
        assert ex["cache_read"] == 900
        assert "cache_creation" not in ex  # falsy values omitted

        usage = session_manager.state.usage
        assert usage.llm_calls == 1
        assert usage.llm_tokens_in == 1200
        assert usage.llm_tokens_out == 18
        assert usage.llm_cache_read == 900

    def test_offtranscript_usage_counts_without_adding_exchange(self, session_manager):
        session_manager.start_session()
        session_manager.add_assistant_message("on-transcript", tokens_in=100, tokens_out=10)
        session_manager.record_llm_usage(1300, 7)  # e.g. a summary call
        assert len(session_manager.state.exchanges) == 1
        usage = session_manager.state.usage
        assert usage.llm_calls == 2
        assert usage.llm_tokens_in == 1400
        assert usage.llm_tokens_out == 17

    def test_stt_and_tts_accumulate(self, session_manager):
        session_manager.start_session()
        session_manager.record_stt(4.2)
        session_manager.record_stt(1.3)
        session_manager.record_tts(20)
        session_manager.record_tts(15)
        usage = session_manager.to_dict()["usage"]
        assert usage["stt_seconds"] == 5.5
        assert usage["tts_chars"] == 35

    def test_record_methods_safe_without_active_session(self, session_manager):
        # No active session — should be no-ops, not raise.
        session_manager.record_stt(3.0)
        session_manager.record_tts(10)
        session_manager.record_llm_usage(100, 10)
        assert session_manager.state is None

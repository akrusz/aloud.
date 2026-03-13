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

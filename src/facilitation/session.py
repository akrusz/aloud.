"""Session state management and context handling."""

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal


@dataclass
class Exchange:
    """A single exchange in the conversation."""

    role: Literal["user", "assistant"]
    content: str
    timestamp: float = field(default_factory=time.time)
    name: str | None = None  # display name (e.g. participant name in noting)
    # LLM usage for assistant turns produced by a completion (None otherwise,
    # e.g. user turns and static/fallback facilitator messages).
    tokens_in: int | None = None
    tokens_out: int | None = None
    cache_read: int | None = None
    cache_creation: int | None = None

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        d = {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
            "time": datetime.fromtimestamp(self.timestamp).isoformat(),
        }
        if self.name:
            d["name"] = self.name
        if self.tokens_in is not None or self.tokens_out is not None:
            d["tokens_in"] = self.tokens_in
            d["tokens_out"] = self.tokens_out
            if self.cache_read:
                d["cache_read"] = self.cache_read
            if self.cache_creation:
                d["cache_creation"] = self.cache_creation
        return d


@dataclass
class SessionUsage:
    """Running tally of compute consumed by a session.

    Three legs mirror the metered-billing model (LLM tokens + STT seconds +
    TTS chars). ``llm_calls`` counts every completion, including off-transcript
    ones (summary, resume-intent, noting labels), so totals here can exceed the
    sum of per-exchange token counts.
    """

    llm_calls: int = 0
    llm_tokens_in: int = 0
    llm_tokens_out: int = 0
    llm_cache_read: int = 0
    llm_cache_creation: int = 0
    stt_seconds: float = 0.0
    tts_chars: int = 0

    def to_dict(self) -> dict:
        return {
            "llm_calls": self.llm_calls,
            "llm_tokens_in": self.llm_tokens_in,
            "llm_tokens_out": self.llm_tokens_out,
            "llm_cache_read": self.llm_cache_read,
            "llm_cache_creation": self.llm_cache_creation,
            "stt_seconds": round(self.stt_seconds, 2),
            "tts_chars": self.tts_chars,
        }


@dataclass
class SessionState:
    """Current state of a meditation session."""

    # Session metadata
    session_id: str = ""
    start_time: float = 0
    end_time: float | None = None

    # Conversation history
    exchanges: list[Exchange] = field(default_factory=list)

    # Session tags/notes
    tags: list[str] = field(default_factory=list)
    notes: str = ""

    # Compute usage tally
    usage: SessionUsage = field(default_factory=SessionUsage)

    @property
    def duration(self) -> float:
        """Session duration in seconds."""
        end = self.end_time or time.time()
        return end - self.start_time

    @property
    def exchange_count(self) -> int:
        """Number of exchanges in the session."""
        return len(self.exchanges)


class SessionManager:
    """Manages session state and conversation context."""

    def __init__(
        self,
        context_strategy: Literal["rolling", "full"] = "full",
        window_size: int = 10,
    ):
        """Initialize session manager.

        Args:
            context_strategy: How to manage conversation context
                - "rolling": Keep last N exchanges
                - "full": Keep entire history
            window_size: Number of exchanges to keep (for rolling strategy)
        """
        self.context_strategy = context_strategy
        self.window_size = window_size

        self._state: SessionState | None = None

    @property
    def state(self) -> SessionState | None:
        """Current session state."""
        return self._state

    @property
    def is_active(self) -> bool:
        """Check if a session is active."""
        return self._state is not None and self._state.end_time is None

    def start_session(self, session_id: str | None = None) -> SessionState:
        """Start a new meditation session.

        Args:
            session_id: Optional session ID (generated if not provided)

        Returns:
            The new session state
        """
        if session_id is None:
            session_id = datetime.now().strftime("%Y-%m-%d-%H%M%S")

        self._state = SessionState(
            session_id=session_id,
            start_time=time.time(),
        )

        return self._state

    def end_session(self) -> SessionState | None:
        """End the current session.

        Returns:
            The final session state, or None if no session was active
        """
        if self._state is None:
            return None

        self._state.end_time = time.time()
        state = self._state
        return state

    def add_user_message(self, content: str, name: str | None = None) -> None:
        """Add a user (meditator) message to the session.

        Args:
            content: The transcribed speech
            name: Optional display name (e.g. "You" in noting circles)
        """
        if self._state is None:
            raise RuntimeError("No active session")

        self._state.exchanges.append(Exchange(
            role="user",
            content=content,
            name=name,
        ))

    def add_assistant_message(
        self,
        content: str,
        name: str | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        cache_read: int | None = None,
        cache_creation: int | None = None,
    ) -> None:
        """Add an assistant (facilitator) message to the session.

        Args:
            content: The facilitator's response
            name: Optional display name (e.g. participant name in noting)
            tokens_in/tokens_out/cache_read/cache_creation: LLM usage from the
                completion that produced this message. Pass None for static or
                fallback messages (no LLM call). When token counts are given,
                they're also folded into the session-level usage tally.
        """
        if self._state is None:
            raise RuntimeError("No active session")

        self._state.exchanges.append(Exchange(
            role="assistant",
            content=content,
            name=name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cache_read=cache_read,
            cache_creation=cache_creation,
        ))

        if tokens_in is not None or tokens_out is not None:
            self.record_llm_usage(tokens_in, tokens_out, cache_read, cache_creation)

    def record_llm_usage(
        self,
        tokens_in: int | None,
        tokens_out: int | None,
        cache_read: int | None = None,
        cache_creation: int | None = None,
    ) -> None:
        """Fold one LLM completion into the session usage tally.

        Use directly for off-transcript completions (summary, resume-intent,
        noting labels); ``add_assistant_message`` calls this for on-transcript
        turns so callers don't double-count.
        """
        if self._state is None:
            return
        u = self._state.usage
        u.llm_calls += 1
        u.llm_tokens_in += tokens_in or 0
        u.llm_tokens_out += tokens_out or 0
        u.llm_cache_read += cache_read or 0
        u.llm_cache_creation += cache_creation or 0

    def record_stt(self, seconds: float) -> None:
        """Accumulate STT audio seconds transcribed this session.

        Counts all transcriptions (including speculative/command audio), since
        each consumes STT compute.
        """
        if self._state is not None and seconds:
            self._state.usage.stt_seconds += seconds

    def record_tts(self, chars: int) -> None:
        """Accumulate TTS characters synthesized server-side this session.

        Browser-side speechSynthesis isn't counted (no server compute).
        """
        if self._state is not None and chars:
            self._state.usage.tts_chars += chars

    def load_exchanges(self, exchanges: list[dict]) -> None:
        """Load saved exchanges into the current session (for continuation).

        Args:
            exchanges: List of dicts with 'role', 'content', and optional 'timestamp'
        """
        if self._state is None:
            raise RuntimeError("No active session")

        for ex in exchanges:
            self._state.exchanges.append(Exchange(
                role=ex["role"],
                content=ex["content"],
                timestamp=ex.get("timestamp", 0),
            ))

    def get_context_messages(self) -> list[dict]:
        """Get conversation history for LLM context.

        Returns context based on the configured strategy.

        Returns:
            List of message dicts with 'role' and 'content'
        """
        if self._state is None:
            return []

        exchanges = self._state.exchanges

        if self.context_strategy == "rolling":
            # Keep last N exchanges
            exchanges = exchanges[-self.window_size:]

        return [
            {"role": e.role, "content": e.content}
            for e in exchanges
        ]

    def get_last_user_message(self) -> str | None:
        """Get the most recent user message.

        Returns:
            The last user message content, or None
        """
        if self._state is None:
            return None

        for exchange in reversed(self._state.exchanges):
            if exchange.role == "user":
                return exchange.content

        return None

    def add_tag(self, tag: str) -> None:
        """Add a tag to the current session.

        Args:
            tag: Tag to add
        """
        if self._state is not None and tag not in self._state.tags:
            self._state.tags.append(tag)

    def set_notes(self, notes: str) -> None:
        """Set notes for the current session.

        Args:
            notes: Session notes
        """
        if self._state is not None:
            self._state.notes = notes

    def to_dict(self) -> dict | None:
        """Convert current session to dictionary.

        Returns:
            Session data as dictionary, or None if no session
        """
        if self._state is None:
            return None

        return {
            "session_id": self._state.session_id,
            "start_time": self._state.start_time,
            "end_time": self._state.end_time,
            "duration": self._state.duration,
            "exchange_count": self._state.exchange_count,
            "tags": self._state.tags,
            "notes": self._state.notes,
            "usage": self._state.usage.to_dict(),
            "exchanges": [e.to_dict() for e in self._state.exchanges],
        }

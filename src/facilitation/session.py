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
        return d


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

    def add_assistant_message(self, content: str, name: str | None = None) -> None:
        """Add an assistant (facilitator) message to the session.

        Args:
            content: The facilitator's response
            name: Optional display name (e.g. participant name in noting)
        """
        if self._state is None:
            raise RuntimeError("No active session")

        self._state.exchanges.append(Exchange(
            role="assistant",
            content=content,
            name=name,
        ))

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
            "exchanges": [e.to_dict() for e in self._state.exchanges],
        }

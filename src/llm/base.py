"""Base classes for LLM providers."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass
class Message:
    """A conversation message."""

    role: Literal["user", "assistant", "system"]
    content: str


@dataclass
class CompletionResult:
    """Result from an LLM completion.

    ``tokens_used`` is the input+output total (kept for backward compat).
    The split fields below are what session usage tracking records, since
    input and output tokens are priced very differently and cache reads are
    far cheaper than fresh input. Any field may be None if the provider
    doesn't report it.
    """

    text: str
    finish_reason: str | None = None
    tokens_used: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_creation_tokens: int | None = None


class LLMProvider(Protocol):
    """Protocol for LLM providers."""

    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int = 300,
    ) -> CompletionResult:
        """Generate a completion from the LLM.

        Args:
            messages: Conversation history
            system: System prompt
            max_tokens: Maximum tokens in response

        Returns:
            CompletionResult with generated text
        """
        ...


class BaseLLMProvider(ABC):
    """Abstract base class for LLM providers."""

    def __init__(
        self,
        model: str,
        max_tokens: int = 300,
    ):
        self.model = model
        self.max_tokens = max_tokens

    @abstractmethod
    async def complete(
        self,
        messages: list[Message],
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> CompletionResult:
        """Generate a completion from the LLM."""
        pass
